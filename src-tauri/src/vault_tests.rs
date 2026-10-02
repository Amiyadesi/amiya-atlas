use crate::{
    domain::{self, Snapshot},
    vault::VaultService,
};

mod tests {
    use super::*;
    use std::fs;

    fn entity(id: &str, name: &str, privacy: &str) -> domain::Entity {
        domain::Entity {
            id: id.into(),
            name: name.into(),
            template_id: Some("project".into()),
            category: "Project".into(),
            status: "ACTIVE".into(),
            privacy: privacy.into(),
            tags: vec![],
            fields: vec![],
            created_at: domain::now(),
            updated_at: domain::now(),
        }
    }
    #[test]
    fn vault_round_trip_and_wrong_password() {
        let path = std::env::temp_dir().join(format!("atlas-test-{}.sqlite", uuid::Uuid::new_v4()));
        let mut vault = VaultService::new(path.clone());
        vault.initialize("correct horse battery staple").unwrap();
        let mut snapshot = Snapshot::default();
        snapshot.entities.push(domain::Entity {
            id: "e1".into(),
            name: "Private service".into(),
            template_id: Some("project".into()),
            category: "Project".into(),
            status: "ACTIVE".into(),
            privacy: "PRIVATE".into(),
            tags: vec![],
            fields: vec![],
            created_at: domain::now(),
            updated_at: domain::now(),
        });
        vault.save(snapshot, &[]).unwrap();
        vault.lock();
        let raw = fs::read_to_string(&path).unwrap_or_default();
        assert!(!raw.contains("Private service"));
        assert!(vault.unlock("wrong password wrong").is_err());
        vault.unlock("correct horse battery staple").unwrap();
        assert_eq!(vault.load().unwrap().entities[0].name, "Private service");
        let _ = fs::remove_file(path);
    }

    #[test]
    fn relation_delete_requires_explicit_unlink() {
        let path =
            std::env::temp_dir().join(format!("atlas-delete-test-{}.sqlite", uuid::Uuid::new_v4()));
        let mut vault = VaultService::new(path.clone());
        vault.initialize("correct horse battery staple").unwrap();
        let mut snapshot = Snapshot {
            revision: 0,
            entities: vec![
                entity("e1", "Source", "PRIVATE"),
                entity("e2", "Target", "PRIVATE"),
            ],
            relations: vec![domain::Relation {
                id: "r1".into(),
                source_id: "e1".into(),
                kind: "RELATED_TO".into(),
                target_id: "e2".into(),
                note: None,
                privacy: "PRIVATE".into(),
                created_at: domain::now(),
            }],
            events: vec![],
            ..Snapshot::default()
        };
        snapshot = vault.save(snapshot, &[]).unwrap();
        let mut pruned = snapshot.clone();
        pruned.entities.retain(|e| e.id != "e1");
        pruned.relations.clear();
        assert!(vault.save(pruned.clone(), &[]).is_err());
        let saved = vault.save(pruned, &["e1".into()]).unwrap();
        assert_eq!(saved.entities.len(), 1);
        assert!(saved.relations.is_empty());
        let _ = fs::remove_file(path);
    }

    #[test]
    fn redaction_removes_secret_topology_and_masks_private_data() {
        let mut snapshot = Snapshot {
            revision: 1,
            entities: vec![
                entity("e1", "Private source", "PRIVATE"),
                entity("e2", "Secret target", "SECRET"),
            ],
            relations: vec![domain::Relation {
                id: "r1".into(),
                source_id: "e1".into(),
                kind: "RELATED_TO".into(),
                target_id: "e2".into(),
                note: Some("private note".into()),
                privacy: "PRIVATE".into(),
                created_at: domain::now(),
            }],
            events: vec![domain::Event {
                id: "ev1".into(),
                entity_id: "e1".into(),
                kind: "REVIEW".into(),
                due_at: Some("2026-12-01".into()),
                due_precision: None,
                recurrence: None,
                policy: Some("REVIEW".into()),
                status: "UPCOMING".into(),
                note: None,
            }],
            ..Snapshot::default()
        };
        snapshot.entities[0].fields.push(domain::Field {
            id: "f1".into(),
            entity_id: "e1".into(),
            key: "note".into(),
            value_type: "text".into(),
            value: "private value".into(),
            privacy: "PRIVATE".into(),
            searchable: true,
            source_of_truth: None,
        });
        let redacted = snapshot.redacted(true);
        assert_eq!(redacted.entities.len(), 1);
        assert!(redacted.relations.is_empty());
        assert!(redacted.events.is_empty());
        assert!(redacted.entities[0].name.starts_with("Asset "));
        assert_eq!(redacted.entities[0].fields[0].value, "");
        assert!(!serde_json::to_string(&redacted).unwrap().contains("SECRET"));
    }

    #[test]
    fn pending_capture_config_and_confirmed_memory_survive_encrypted_storage_and_backup() {
        use crate::{
            ai::AiConfig,
            capture::{self, Capture, Proposal, ProposalRecord},
        };
        let dir = tempfile::tempdir().unwrap();
        let mut vault = VaultService::new(dir.path().join("atlas.sqlite"));
        vault.initialize("correct horse battery staple").unwrap();
        let raw = "SuperGrok 已付到 2026 年 12 月，以后不续。";
        let input = Capture {
            id: "capture-1".into(),
            raw_text: raw.into(),
            input_type: "text".into(),
            timestamp: domain::now(),
            status: "PENDING".into(),
        };
        let proposal: Proposal = serde_json::from_value(serde_json::json!({"entitiesToCreate":[{"ref":"grok","name":"SuperGrok","type":"Subscription","status":"ACTIVE","attributes":{},"notes":"","evidence":"SuperGrok"}],"entitiesToUpdate":[],"relationsToCreate":[],"eventsToCreate":[{"entityRef":"grok","type":"EXPIRY","dueAt":"2026-12","precision":"month","policy":"DO_NOT_RENEW","note":"不续费","evidence":"以后不续"}],"uncertainty":[]})).unwrap();
        let mut snapshot = vault.load().unwrap();
        snapshot.captures.push(input.clone());
        snapshot.proposals.push(ProposalRecord {
            id: "proposal-1".into(),
            capture_id: input.id.clone(),
            content: proposal.clone(),
            status: "PENDING".into(),
            provider: "test".into(),
            created_at: domain::now(),
            entity_ids: vec![],
        });
        snapshot.ai_config = Some(AiConfig {
            kind: "openai-compatible".into(),
            base_url: "https://api.example.invalid/v1".into(),
            model: "test".into(),
            api_key: "credential-for-storage-test".into(),
            response_format: "json_object".into(),
        });
        vault.save(snapshot, &[]).unwrap();
        assert!(vault.load().unwrap().entities.is_empty());
        let bytes = fs::read(&vault.path).unwrap();
        for sensitive in [raw, "credential-for-storage-test", "SuperGrok"] {
            assert!(!bytes
                .windows(sensitive.len())
                .any(|window| window == sensitive.as_bytes()));
        }
        let backup = vault.backup().unwrap();
        vault.lock();
        vault.unlock("correct horse battery staple").unwrap();
        let current = vault.load().unwrap();
        assert_eq!(current.captures[0].raw_text, raw);
        assert_eq!(current.proposals.len(), 1);
        let (mut next, entity_ids) = capture::apply_proposal(&current, &input, &proposal).unwrap();
        next.captures[0].status = "CONFIRMED".into();
        next.proposals[0].status = "CONFIRMED".into();
        next.proposals[0].entity_ids = entity_ids;
        vault.save(next, &[]).unwrap();
        assert_eq!(vault.load().unwrap().entities.len(), 1);
        assert_eq!(
            vault.load().unwrap().events[0].due_at.as_deref(),
            Some("2026-12")
        );
        let redacted = serde_json::to_string(&vault.load().unwrap().redacted(true)).unwrap();
        assert!(!redacted.contains(raw));
        assert!(!redacted.contains("credential-for-storage-test"));
        assert!(!redacted.contains("proposal-1"));
        let mut restored = VaultService::new(dir.path().join("restored.sqlite"));
        assert!(restored.restore(&backup, "wrong password wrong").is_err());
        restored
            .restore(&backup, "correct horse battery staple")
            .unwrap();
        assert!(restored.load().unwrap().entities.is_empty());
        assert_eq!(restored.load().unwrap().captures[0].raw_text, raw);
        assert_eq!(
            restored.load().unwrap().ai_config.unwrap().api_key,
            "credential-for-storage-test"
        );
    }

    #[test]
    fn old_snapshot_without_capture_fields_deserializes() {
        let snapshot: Snapshot =
            serde_json::from_str(r#"{"revision":3,"entities":[],"relations":[],"events":[]}"#)
                .unwrap();
        assert_eq!(snapshot.revision, 3);
        assert!(snapshot.captures.is_empty());
        assert!(snapshot.proposals.is_empty());
        assert!(snapshot.ai_config.is_none());
        snapshot.validate().unwrap();
    }
}
