use crate::{
    capture::{self, Capture, Proposal, ProposalRecord},
    domain::{self, Snapshot},
    vault::VaultService,
};
use serde_json::json;

fn fixture() -> (Snapshot, Proposal) {
    let timestamp = domain::now();
    let mut snapshot: Snapshot = serde_json::from_value(json!({"revision":1,"entities":[
        {"id":"sim","name":"Saily","category":"SIM","status":"ACTIVE","privacy":"PRIVATE","tags":[],"fields":[{"id":"cost","entityId":"sim","key":"monthly_cost","valueType":"number","value":6,"privacy":"PRIVATE","searchable":true},{"id":"country","entityId":"sim","key":"country","valueType":"text","value":"US","privacy":"PRIVATE","searchable":true}],"createdAt":timestamp,"updatedAt":timestamp},
        {"id":"account","name":"Reddit Main","category":"Account","status":"ACTIVE","privacy":"PRIVATE","tags":[],"fields":[],"createdAt":timestamp,"updatedAt":timestamp}],
        "relations":[{"id":"recovery","sourceId":"account","targetId":"sim","type":"RECOVERS_WITH","privacy":"PRIVATE","createdAt":timestamp}],
        "events":[{"id":"review","entityId":"sim","type":"REVIEW","dueAt":"2026-12","duePrecision":"month","policy":"REVIEW","status":"UPCOMING"}]})).unwrap();
    let raw = "从 Atlas 删除 Saily，并新增 3HK 香港备用号码。";
    let mut proposal: Proposal=serde_json::from_value(json!({"entitiesToCreate":[{"ref":"new","name":"3HK","type":"Phone / SIM","status":"ACTIVE","attributes":{"region":"HK"},"notes":"","evidence":raw}],"entitiesToUpdate":[],"relationsToCreate":[],"eventsToCreate":[],"entitiesToDelete":[{"id":"sim","evidence":raw}],"uncertainty":[]})).unwrap();
    capture::stage_versions(&snapshot, &mut proposal).unwrap();
    snapshot.captures.push(Capture {
        id: "capture".into(),
        raw_text: raw.into(),
        input_type: "voice".into(),
        timestamp: timestamp.clone(),
        status: "PENDING".into(),
    });
    snapshot.proposals.push(ProposalRecord {
        id: "proposal".into(),
        capture_id: "capture".into(),
        status: "PENDING".into(),
        content: proposal.clone(),
        provider: "test".into(),
        created_at: timestamp,
        entity_ids: vec![],
        base_revision: Some(1),
        undo: None,
    });
    snapshot.validate().unwrap();
    (snapshot, proposal)
}
#[test]
fn mixed_changes_remove_disclosed_dependencies_and_undo_restores_original_values() {
    let (before, proposal) = fixture();
    let (mut next, unlink) = capture::confirm(&before, "proposal", &proposal).unwrap();
    assert_eq!(unlink, vec!["sim"]);
    assert!(before.entities.iter().any(|e| e.id == "sim"));
    assert!(!next.entities.iter().any(|e| e.id == "sim"));
    assert!(next.relations.is_empty());
    assert!(next.events.is_empty());
    assert_eq!(next.entities.iter().filter(|e| e.name == "3HK").count(), 1);
    next.revision += 1;
    let (restored, _) = capture::undo(&next, "proposal").unwrap();
    for expected in &before.entities {
        let actual = restored
            .entities
            .iter()
            .find(|entity| entity.id == expected.id)
            .unwrap();
        assert_eq!(
            serde_json::to_value(actual).unwrap(),
            serde_json::to_value(expected).unwrap()
        );
    }
    assert_eq!(restored.entities.len(), before.entities.len());
    assert_eq!(
        serde_json::to_value(&restored.relations).unwrap(),
        serde_json::to_value(&before.relations).unwrap()
    );
    assert_eq!(
        serde_json::to_value(&restored.events).unwrap(),
        serde_json::to_value(&before.events).unwrap()
    );
    assert_eq!(restored.captures[0].raw_text, before.captures[0].raw_text);
    assert_eq!(restored.proposals[0].status, "PENDING");
}
#[test]
fn stale_versions_graph_edits_and_injected_targets_cannot_commit() {
    let (mut current, proposal) = fixture();
    current.revision += 1;
    assert!(capture::confirm(&current, "proposal", &proposal)
        .unwrap_err()
        .contains("记忆库已变化"));
    let (mut current, proposal) = fixture();
    current.entities[0].updated_at = "2026-10-07T00:00:00Z".into();
    assert!(capture::confirm(&current, "proposal", &proposal).is_err());
    let (current, mut proposal) = fixture();
    proposal.entities_to_delete[0].id = "account".into();
    assert!(capture::confirm(&current, "proposal", &proposal)
        .unwrap_err()
        .contains("目标"));
    let (current, proposal) = fixture();
    let (mut next, _) = capture::confirm(&current, "proposal", &proposal).unwrap();
    next.revision += 2;
    assert!(capture::undo(&next, "proposal")
        .unwrap_err()
        .contains("后续变更"));
}
#[test]
fn abandonment_negated_deletion_and_hidden_cascades_are_not_entity_deletion() {
    for raw in [
        "Saily 不用了",
        "不要删除 Saily，删除 Reddit Main",
        "删除 Saily 的月费属性",
        "移除 Saily 的复查提醒",
        "请勿删除 Saily",
        "别移除 Saily",
        "Don’t delete Saily",
    ] {
        let (mut current, mut proposal) = fixture();
        current.captures[0].raw_text = raw.into();
        proposal.entities_to_delete[0].evidence = raw.into();
        proposal.entities_to_create.clear();
        assert!(capture::apply_proposal(&current, &current.captures[0], &proposal).is_err());
    }
    let (mut current, proposal) = fixture();
    current.relations[0].privacy = "SECRET".into();
    assert!(
        capture::apply_proposal(&current, &current.captures[0], &proposal)
            .unwrap_err()
            .contains("隐藏关联")
    );
}
#[test]
fn field_removal_and_retirement_preserve_unmentioned_data() {
    let (mut current, _) = fixture();
    let raw = "删除 Saily 的月费属性，其他保留。";
    current.captures[0].raw_text = raw.into();
    let proposal: Proposal=serde_json::from_value(json!({"entitiesToCreate":[],"entitiesToUpdate":[{"id":"sim","expectedUpdatedAt":current.entities[0].updated_at,"name":"Saily","type":"Phone / SIM","status":"INACTIVE","attributes":{},"attributesToRemove":["monthly_cost"],"notes":"","evidence":raw}],"relationsToCreate":[],"eventsToCreate":[],"uncertainty":[]})).unwrap();
    let (next, _) = capture::apply_proposal(&current, &current.captures[0], &proposal).unwrap();
    let sim = &next.entities[0];
    assert_eq!(sim.status, "INACTIVE");
    assert_eq!(sim.category, "SIM");
    assert!(!sim.fields.iter().any(|f| f.key == "monthly_cost"));
    assert_eq!(sim.fields[0].value, "US");
    assert_eq!(next.relations.len(), current.relations.len());
    current.entities[0].fields[0].privacy = "SECRET".into();
    assert!(capture::apply_proposal(&current, &current.captures[0], &proposal).is_err());
}
#[test]
fn unrelated_fields_events_and_relations_cannot_be_removed() {
    let (mut current, _) = fixture();
    for (raw, key, target) in [
        ("取消 Other 的提醒", "eventsToDelete", "review"),
        ("解除 Other 的关联", "relationsToDelete", "recovery"),
    ] {
        current.captures[0].raw_text = raw.into();
        let mut value = json!({"entitiesToCreate":[],"entitiesToUpdate":[],"relationsToCreate":[],"eventsToCreate":[],"uncertainty":[]});
        value[key] = json!([{"id":target,"evidence":raw}]);
        let proposal: Proposal = serde_json::from_value(value).unwrap();
        assert!(
            capture::apply_proposal(&current, &current.captures[0], &proposal)
                .unwrap_err()
                .contains("对象不明确")
        );
    }
    let raw = "删除 Other 的月费属性";
    current.captures[0].raw_text = raw.into();
    let proposal:Proposal=serde_json::from_value(json!({"entitiesToCreate":[],"entitiesToUpdate":[{"id":"sim","expectedUpdatedAt":current.entities[0].updated_at,"name":"Saily","type":"Phone / SIM","status":"ACTIVE","attributes":{},"attributesToRemove":["monthly_cost"],"notes":"","evidence":raw}],"relationsToCreate":[],"eventsToCreate":[],"uncertainty":[]})).unwrap();
    assert!(
        capture::apply_proposal(&current, &current.captures[0], &proposal)
            .unwrap_err()
            .contains("对象不明确")
    );
}
#[test]
fn unlink_removes_only_the_selected_relation_and_old_proposals_remain_compatible() {
    let (mut current, _) = fixture();
    let raw = "解除 Reddit Main 和 Saily 的找回关联。";
    current.captures[0].raw_text = raw.into();
    let proposal:Proposal=serde_json::from_value(json!({"entitiesToCreate":[],"entitiesToUpdate":[],"relationsToCreate":[],"eventsToCreate":[],"relationsToDelete":[{"id":"recovery","evidence":raw}],"uncertainty":[]})).unwrap();
    let (next, _) = capture::apply_proposal(&current, &current.captures[0], &proposal).unwrap();
    assert_eq!(next.entities.len(), 2);
    assert!(next.relations.is_empty());
    assert_eq!(next.events.len(), 1);
    let old:Proposal=serde_json::from_value(json!({"entitiesToCreate":[],"entitiesToUpdate":[],"relationsToCreate":[],"eventsToCreate":[],"uncertainty":[]})).unwrap();
    assert!(old.entities_to_delete.is_empty());
    assert!(old.relations_to_delete.is_empty());
}
#[test]
fn encrypted_backup_preserves_undo_and_atomic_delete_through_restart() {
    let dir = tempfile::tempdir().unwrap();
    let mut vault = VaultService::new(dir.path().join("atlas.sqlite"));
    let password = "correct horse battery staple";
    vault.initialize(password).unwrap();
    let (mut staged, proposal) = fixture();
    staged.revision = vault.load().unwrap().revision;
    staged.proposals[0].base_revision = Some(staged.revision + 1);
    let before = vault.save(staged, &[]).unwrap();
    let (next, unlink) = capture::confirm(&before, "proposal", &proposal).unwrap();
    let committed = vault.save(next, &unlink).unwrap();
    assert!(committed.entities.iter().all(|e| e.id != "sim"));
    let backup = vault.backup().unwrap();
    assert!(!backup.contains("Saily"));
    vault.lock();
    let current = vault.unlock(password).unwrap();
    assert!(current.proposals[0].undo.is_some());
    vault.restore(&backup, password).unwrap();
    let (next, unlink) = capture::undo(&vault.load().unwrap(), "proposal").unwrap();
    let restored = vault.save(next, &unlink).unwrap();
    assert_eq!(
        restored
            .entities
            .iter()
            .find(|e| e.id == "sim")
            .unwrap()
            .fields[0]
            .value,
        6
    );
    assert_eq!(restored.relations[0].id, "recovery");
    assert_eq!(restored.events[0].id, "review");
    assert!(restored.entities.iter().all(|e| e.name != "3HK"));
    assert_eq!(restored.captures[0].status, "PENDING");
}
