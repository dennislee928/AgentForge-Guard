//! Secret redaction for audit records and output excerpts.
//!
//! Redaction is best effort. It recognizes common credential formats and
//! assignments, but it cannot recognize every secret, which is why afg never
//! records the environment's values. Redaction never fails; it only ever
//! removes information.

use regex::{Captures, Regex};

use crate::audit::AuditRecord;

pub const MARK: &str = "[REDACTED]";

#[derive(Debug, Clone)]
pub struct Redactor {
    rules: Vec<(Regex, Replace)>,
    secret_flag: Regex,
}

#[derive(Debug, Clone, Copy)]
enum Replace {
    /// Replace the whole match.
    Whole(&'static str),
    /// Keep capture group 1 (and group 2, if the pattern has one, as a
    /// suffix) and replace the rest of the match.
    KeepPrefix,
}

impl Default for Redactor {
    fn default() -> Self {
        Self::new()
    }
}

impl Redactor {
    pub fn new() -> Self {
        let r = |s: &str| Regex::new(s).expect("valid redaction regex");
        let rules = vec![
            // PEM private keys, including truncated ones.
            (
                r(
                    r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----(?s:.*?)(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|\z)",
                ),
                Replace::Whole("[REDACTED:private-key]"),
            ),
            // Credentials embedded in URLs: scheme://user:pass@host
            (r(r"(://[^/\s:@]+:)[^@\s/]+(@)"), Replace::KeepPrefix),
            // Authorization headers.
            (
                r(r"(?i)(authorization:\s*(?:bearer|basic|token)\s+)\S+"),
                Replace::KeepPrefix,
            ),
            (
                r(r"(?i)(\bbearer\s+)[A-Za-z0-9._~+/=-]{8,}"),
                Replace::KeepPrefix,
            ),
            // Well-known token formats.
            (
                r(r"\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA|AIPA)[A-Z0-9]{16}\b"),
                Replace::Whole("[REDACTED:aws-key-id]"),
            ),
            (
                r(r"\bgh[pousr]_[A-Za-z0-9]{36,255}\b"),
                Replace::Whole("[REDACTED:github-token]"),
            ),
            (
                r(r"\bgithub_pat_[A-Za-z0-9_]{22,255}\b"),
                Replace::Whole("[REDACTED:github-token]"),
            ),
            (
                r(r"\bglpat-[A-Za-z0-9_-]{20,}\b"),
                Replace::Whole("[REDACTED:gitlab-token]"),
            ),
            (
                r(r"\bxox[abposr]-[A-Za-z0-9-]{10,}\b"),
                Replace::Whole("[REDACTED:slack-token]"),
            ),
            (
                r(r"https://hooks\.slack\.com/services/[A-Za-z0-9/_-]+"),
                Replace::Whole("[REDACTED:slack-webhook]"),
            ),
            (
                r(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}"),
                Replace::Whole("[REDACTED:jwt]"),
            ),
            (
                r(r"\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}"),
                Replace::Whole("[REDACTED:api-key]"),
            ),
            (
                r(r"\bAIza[0-9A-Za-z_-]{35}\b"),
                Replace::Whole("[REDACTED:google-api-key]"),
            ),
            (
                r(r"\b[rs]k_(?:live|test)_[0-9A-Za-z]{16,}\b"),
                Replace::Whole("[REDACTED:stripe-key]"),
            ),
            (
                r(r"\bnpm_[A-Za-z0-9]{36}\b"),
                Replace::Whole("[REDACTED:npm-token]"),
            ),
            // NAME=value and NAME: value, where NAME suggests a secret.
            (
                r(
                    r#"(?i)(\b(?:[A-Z0-9_.-]*(?:secret|token|passwd|password|pwd|api[_-]?key|access[_-]?key|private[_-]?key|credentials?)[A-Z0-9_.-]*|[A-Z0-9_.-]*auth)\s*[=:]\s*["']?)[^\s"'&,;]+"#,
                ),
                Replace::KeepPrefix,
            ),
        ];
        let secret_flag = r(
            r"(?i)^--?[a-z0-9-]*(?:password|passwd|token|secret|api-?key|access-?key|private-?key|auth)$",
        );
        Self { rules, secret_flag }
    }

    /// Redact secrets in free text.
    pub fn redact_text(&self, s: &str) -> String {
        let mut out = s.to_owned();
        for (re, rep) in &self.rules {
            out = match rep {
                Replace::Whole(w) => re.replace_all(&out, *w).into_owned(),
                Replace::KeepPrefix => re
                    .replace_all(&out, |c: &Captures<'_>| {
                        format!("{}{MARK}{}", &c[1], c.get(2).map_or("", |m| m.as_str()))
                    })
                    .into_owned(),
            };
        }
        out
    }

    /// Redact an argv. Besides the text rules, the value that follows a
    /// secret-looking flag (`--password hunter2`) is replaced.
    pub fn redact_argv(&self, argv: &[String]) -> Vec<String> {
        let mut out = Vec::with_capacity(argv.len());
        let mut next_is_secret = false;
        for a in argv {
            if next_is_secret {
                out.push(MARK.to_owned());
                next_is_secret = false;
                continue;
            }
            next_is_secret = self.secret_flag.is_match(a);
            out.push(self.redact_text(a));
        }
        out
    }

    pub fn redact_record(&self, r: &mut AuditRecord) {
        let original = r.argv.clone();
        r.argv = self.redact_argv(&r.argv);
        // Reasons may quote argv elements, so redact any value that was
        // redacted in argv, as well as the text patterns.
        let removed: Vec<&String> = original
            .iter()
            .zip(&r.argv)
            .filter(|(o, n)| o != n && o.len() >= 4)
            .map(|(o, _)| o)
            .collect();
        let scrub = |s: &str| {
            let mut t = s.to_owned();
            for o in &removed {
                t = t.replace(o.as_str(), MARK);
            }
            self.redact_text(&t)
        };
        r.decision.reasons = r.decision.reasons.iter().map(|s| scrub(s)).collect();
        r.cwd = scrub(&r.cwd);
        if let Some(e) = &r.error {
            r.error = Some(scrub(e));
        }
        if let Some(x) = &mut r.execution {
            for (_, v) in &mut x.details {
                *v = scrub(v);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    fn red(s: &str) -> String {
        Redactor::new().redact_text(s)
    }

    // Fake secrets in each format. None of them is real.
    const SECRETS: &[&str] = &[
        "AKIAABCDEFGHIJKLMNOP",
        "ghp_0123456789abcdefghijklmnopqrstuvwxyzAB",
        "github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz",
        "glpat-abcdefghijklmnopqrstu",
        "xoxb-1234567890-abcdefghij",
        "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1rwW1gFWFOEjXk",
        "sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345",
        "sk-proj-abcdefghijklmnopqrstuvwxyz",
        // Split so secret scanners do not report this fake key as a leak.
        concat!("AIza", "SyA-abcdefghijklmnopqrstuvwxyz01234"),
        "sk_live_abcdefghijklmnop1234",
        "npm_abcdefghijklmnopqrstuvwxyz0123456789",
    ];

    #[test]
    fn token_formats() {
        for s in SECRETS {
            let out = red(&format!("value {s} end"));
            assert!(!out.contains(s), "{s} -> {out}");
            assert!(out.contains("[REDACTED"), "{out}");
            assert!(out.starts_with("value ") && out.ends_with(" end"), "{out}");
        }
    }

    #[test]
    fn pem_blocks() {
        let pem = "a\n-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk\n-----END OPENSSH PRIVATE KEY-----\nz";
        assert_eq!(red(pem), "a\n[REDACTED:private-key]\nz");
        let truncated = "-----BEGIN RSA PRIVATE KEY-----\nMIIEow";
        assert_eq!(red(truncated), "[REDACTED:private-key]");
    }

    #[test]
    fn assignments_urls_and_headers() {
        assert_eq!(red("DB_PASSWORD=hunter2"), "DB_PASSWORD=[REDACTED]");
        assert_eq!(
            red("export API_KEY='abc123'"),
            "export API_KEY='[REDACTED]'"
        );
        assert_eq!(
            red("aws_secret_access_key: wJalrXUtnFEMI"),
            "aws_secret_access_key: [REDACTED]"
        );
        assert_eq!(
            red("postgres://app:s3cret@db:5432/x"),
            "postgres://app:[REDACTED]@db:5432/x"
        );
        assert_eq!(
            red("Authorization: Bearer abc.def.ghi"),
            "Authorization: Bearer [REDACTED]"
        );
        assert_eq!(red("--token=abcdef"), "--token=[REDACTED]");
        assert_eq!(red("BASIC_AUTH=user:pw"), "BASIC_AUTH=[REDACTED]");
    }

    #[test]
    fn harmless_text_untouched() {
        for s in [
            "cargo test --workspace",
            "git log --author=alice",
            "https://example.com/a:b",
            "tokenizer.rs",
            "oauth-client",
            "author: alice",
        ] {
            assert_eq!(red(s), s);
        }
    }

    #[test]
    fn flag_value_pairs_in_argv() {
        let argv: Vec<String> = [
            "psql",
            "--password",
            "hunter2",
            "-h",
            "db",
            "--api-key",
            "k3y",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        assert_eq!(
            Redactor::new().redact_argv(&argv),
            ["psql", "--password", MARK, "-h", "db", "--api-key", MARK]
        );
    }

    #[test]
    fn record_reasons_scrubbed() {
        use crate::audit::{AuditRecord, DecisionRecord, PolicyRef};
        let mut r = AuditRecord {
            schema: "s".into(),
            id: "i".into(),
            timestamp: "t".into(),
            afg_version: "v".into(),
            source: "run".into(),
            argv: vec!["mysql".into(), "--password".into(), "hunter2xyz".into()],
            cwd: "/w".into(),
            policy: PolicyRef {
                version: "v".into(),
                hash: "h".into(),
            },
            decision: DecisionRecord {
                effect: afg_core::Effect::Deny,
                backend: None,
                rule_id: "r".into(),
                reasons: vec!["argument `hunter2xyz` refers to ...".into()],
                program: None,
                opaque: false,
            },
            approval: None,
            execution: None,
            error: Some("failed with token=abc".into()),
        };
        Redactor::new().redact_record(&mut r);
        let json = serde_json::to_string(&r).unwrap();
        assert!(!json.contains("hunter2xyz"), "{json}");
        assert!(!json.contains("token=abc"), "{json}");
    }

    proptest! {
        #[test]
        fn seeded_secrets_never_survive(
            prefix in "[a-z /=:-]{0,20}",
            suffix in "[a-z /.-]{0,20}",
            idx in 0..SECRETS.len(),
        ) {
            let s = SECRETS[idx];
            let input = format!("{prefix} {s} {suffix}");
            let out = Redactor::new().redact_text(&input);
            prop_assert!(!out.contains(s), "{} -> {}", input, out);
        }

        #[test]
        fn assigned_values_never_survive(
            name in "(DB_|APP_|)(PASSWORD|SECRET|TOKEN|API_KEY)",
            value in "[A-Za-z0-9]{6,24}",
        ) {
            let input = format!("{name}={value}");
            let out = Redactor::new().redact_text(&input);
            prop_assert!(!out.contains(&value), "{} -> {}", input, out);
        }

        #[test]
        fn redaction_is_idempotent(s in ".{0,80}") {
            let r = Redactor::new();
            let once = r.redact_text(&s);
            prop_assert_eq!(r.redact_text(&once), once);
        }
    }
}
