use crate::{
    domain::{self, Snapshot},
    vault::VaultService,
};

mod tests {
    use super::*;
    use std::fs;
    #[test]
    fn ledger_migration_backup_restore_and_unknown_preservation() {
        let dir=tempfile::tempdir().unwrap();let path=dir.path().join("synthetic.sqlite");let mut vault=VaultService::new(path.clone());
        let password="synthetic migration password";vault.initialize(password).unwrap();
        let mut old=vault.load().unwrap();let mut e=entity("legacy","Synthetic legacy service","PRIVATE");e.fields.push(domain::Field{id:"legacy-cost".into(),entity_id:e.id.clone(),key:"cost".into(),value_type:"text".into(),value:serde_json::json!("30 USD / month"),privacy:"PRIVATE".into(),searchable:false,source_of_truth:None});old.entities.push(e);
        let old=vault.save(old,&[]).unwrap();let before=vault.backup().unwrap();
        let mut next=old.clone();let finance=crate::ledger::tests::fixture();next.ledger_accounts=finance.ledger_accounts;next.transactions=finance.transactions;next.opaque_records.push(serde_json::json!({"kind":"FutureAllocation","data":{"id":"future","payload":"keep"}}));
        let saved=vault.save(next,&[]).unwrap();let after=vault.backup().unwrap();assert!(!after.contains("Synthetic legacy service"));assert!(!after.contains("synthetic cash"));
        let raw=fs::read(&path).unwrap();assert!(!raw.windows(14).any(|v|v==b"synthetic cash"));
        let mut old_style=saved.clone();old_style.opaque_records.clear();assert_eq!(vault.save(old_style,&[]).unwrap().opaque_records,saved.opaque_records);
        vault.lock();let reopened=vault.unlock(password).unwrap();assert_eq!(reopened.transactions.len(),1);assert_eq!(reopened.entities[0].fields[0].value,"30 USD / month");
        let restored=vault.restore(&before,password).unwrap();assert!(restored.transactions.is_empty());assert_eq!(restored.entities.len(),1);
        let restored=vault.restore(&after,password).unwrap();assert_eq!(restored.transactions.len(),1);assert_eq!(restored.opaque_records,saved.opaque_records);
        let mut broken:serde_json::Value=serde_json::from_str(&after).unwrap();broken["records"][0]["ciphertext"][0]=serde_json::json!(999);assert!(vault.restore(&broken.to_string(),password).is_err());
        assert_eq!(vault.load().unwrap().transactions.len(),1);
    }

    #[cfg(windows)]
    #[test]
    fn remembered_device_unlock_reopens_and_can_be_disabled() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("atlas.sqlite");
        let mut vault = VaultService::new(path.clone());
        vault.initialize("correct horse battery staple").unwrap();
        let mut snapshot = vault.load().unwrap();
        snapshot.entities.push(entity("e1", "Private remembered asset", "PRIVATE"));
        vault.save(snapshot, &[]).unwrap();
        vault.set_device_unlock(true).unwrap();
        let protected = fs::read(path.with_extension("device-unlock.dpapi")).unwrap();
        assert!(!protected.windows(28).any(|w| w == b"correct horse battery staple"));
        vault.lock();
        let mut reopened = VaultService::new(path.clone());
        assert!(reopened.device_unlock_enabled());
        assert_eq!(reopened.unlock_device().unwrap().entities[0].name, "Private remembered asset");
        reopened.set_device_unlock(false).unwrap();
        reopened.lock();
        assert!(!reopened.device_unlock_enabled());
        assert!(reopened.unlock_device().is_err());
        reopened.unlock("correct horse battery staple").unwrap();
        reopened.set_device_unlock(true).unwrap();
        let mut damaged = fs::read(path.with_extension("device-unlock.dpapi")).unwrap();
        let last = damaged.len() - 1; damaged[last] ^= 1;
        fs::write(path.with_extension("device-unlock.dpapi"), damaged).unwrap();
        assert!(reopened.unlock_device().is_err());
        assert!(!reopened.unlocked());
        reopened.unlock("correct horse battery staple").unwrap();
    }

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
            input_type: "voice".into(),
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
            base_revision: None,
            undo: None,
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

    #[test]
    fn cloud_session_is_encrypted_hidden_and_survives_normal_edits_and_backup() {
        let dir=tempfile::tempdir().unwrap();
        let mut vault=VaultService::new(dir.path().join("atlas.sqlite"));
        vault.initialize("test-master-password-123").unwrap();
        vault.set_cloud_session(Some(crate::cloud::CloudSession{token:"private-cloud-token-for-test-123".into(),email:"test@example.invalid".into(),expires_at:123456789})).unwrap();
        let loaded=vault.load().unwrap();
        let json=serde_json::to_string(&loaded).unwrap();
        assert!(!json.contains("private-cloud-token")&&!json.contains("cloudSession"));
        let edit:Snapshot=serde_json::from_str(&json).unwrap();
        let saved=vault.save(edit,&[]).unwrap();
        assert_eq!(saved.cloud_session.as_ref().unwrap().token,"private-cloud-token-for-test-123");
        assert!(!serde_json::to_string(&saved.redacted(true)).unwrap().contains("private-cloud-token"));
        let backup=vault.backup().unwrap();assert!(!backup.contains("private-cloud-token"));
        vault.lock();vault.unlock("test-master-password-123").unwrap();
        assert!(vault.load().unwrap().cloud_session.is_some());
        let mut restored=VaultService::new(dir.path().join("restored.sqlite"));restored.restore(&backup,"test-master-password-123").unwrap();
        assert!(restored.load().unwrap().cloud_session.is_some());
        let needle = b"private-cloud-token-for-test-123";
        assert!(!fs::read(&vault.path).unwrap().windows(needle.len()).any(|part|part==needle));
        vault.set_cloud_session(None).unwrap();assert!(vault.load().unwrap().cloud_session.is_none());
    }
}
