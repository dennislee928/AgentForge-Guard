//! `afg run` through the Cloudflare backend, end to end against the mock
//! Worker (T11.5).

#[path = "../../../tests/cloudflare-contract/mock_worker.rs"]
mod mock_worker;

use assert_cmd::Command;
use mock_worker::MockWorker;

/// A fresh random signing key for each test, so no key material is hard-coded.
fn test_key() -> (Vec<u8>, String) {
    let mut key = vec![0u8; 32];
    getrandom::fill(&mut key).unwrap();
    let hex = key.iter().map(|b| format!("{b:02x}")).collect();
    (key, hex)
}

fn repo(endpoint: &str, cap: u64) -> tempfile::TempDir {
    let d = tempfile::tempdir().unwrap();
    std::fs::write(
        d.path().join("agentforge.yaml"),
        format!(
            "apiVersion: agentforge.dev/v1alpha1\nkind: AgentPolicy\nproject: {{ name: cf }}\n\
             execution:\n  backends:\n    cloudflare: {{ enabled: true, endpoint: '{endpoint}', maxRunsPerHour: {cap} }}\n\
             rules:\n  - {{ id: remote-scripts, effect: route, backend: cloudflare, commands: [[sh]] }}\n"
        ),
    )
    .unwrap();
    std::fs::write(d.path().join("check.sh"), "echo ok\n").unwrap();
    std::fs::write(
        d.path().join(".env"),
        "AWS_SECRET_ACCESS_KEY=FAKEFAKEFAKE\n",
    )
    .unwrap();
    d
}

fn afg(dir: &std::path::Path, key_hex: &str) -> Command {
    let mut c = Command::cargo_bin("afg").unwrap();
    c.current_dir(dir)
        .env("AFG_NO_TTY", "1")
        .env("AFG_CLOUDFLARE_KEY", key_hex);
    c
}

#[test]
fn routed_command_runs_remotely_with_cost_cap() {
    let (key, key_hex) = test_key();
    let worker = MockWorker::start(key, 3);
    let r = repo(&worker.url, 1);
    // The exit code comes back from the remote run.
    afg(r.path(), &key_hex)
        .args(["run", "--", "sh", "check.sh"])
        .assert()
        .code(3);
    let reqs = worker.requests();
    assert_eq!(reqs.len(), 1);
    assert!(reqs[0].signature_ok);
    assert_eq!(
        reqs[0].files,
        ["agentforge.yaml", "check.sh"],
        ".env must not be uploaded"
    );

    // The second run in the same hour hits maxRunsPerHour: 1 before any upload.
    afg(r.path(), &key_hex)
        .args(["run", "--", "sh", "check.sh"])
        .assert()
        .code(125)
        .stderr(predicates::str::contains("cost cap"));
    assert_eq!(worker.requests().len(), 1);

    let out = afg(r.path(), &key_hex)
        .args(["audit", "tail", "--json"])
        .output()
        .unwrap();
    let first: serde_json::Value =
        serde_json::from_str(String::from_utf8_lossy(&out.stdout).lines().next().unwrap()).unwrap();
    assert_eq!(first["decision"]["backend"], "cloudflare");
    assert_eq!(first["execution"]["exitCode"], 3);
}

#[test]
fn doctor_and_missing_key() {
    let (key, key_hex) = test_key();
    let worker = MockWorker::start(key, 0);
    let r = repo(&worker.url, 10);
    let out = afg(r.path(), &key_hex)
        .args(["doctor", "--json"])
        .output()
        .unwrap();
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    let cf = v["backends"]
        .as_array()
        .unwrap()
        .iter()
        .find(|b| b["backend"] == "cloudflare")
        .unwrap()
        .clone();
    assert_eq!(cf["available"], true, "{cf}");

    let home = tempfile::tempdir().unwrap();
    Command::cargo_bin("afg")
        .unwrap()
        .current_dir(r.path())
        .env("AFG_NO_TTY", "1")
        .env_remove("AFG_CLOUDFLARE_KEY")
        .env("HOME", home.path())
        .args(["run", "--", "sh", "check.sh"])
        .assert()
        .code(125)
        .stderr(predicates::str::contains("no Cloudflare key"));
}
