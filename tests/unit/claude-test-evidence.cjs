'use strict';

function nativeModel(model) {
  if (model === 'sonnet') return 'claude-sonnet-5';
  if (model === 'fable') return 'claude-fable-5-1';
  return model;
}

function transcriptEvidence(value) {
  const sessionId = value.session_id || value.launch_id;
  const observedModel = nativeModel(value.observed_model);
  const result = {
    ...value,
    observed_model: observedModel,
    session_id: sessionId,
  };
  if (!result.selection_evidence && observedModel && value.observed_effort) {
    result.selection_evidence = {
      source: 'claude-session-assistant-transcript',
      session_id: sessionId,
      assistant_records: 1,
      model: observedModel,
      effort: value.observed_effort,
      transcript: { path: `/recorded-sessions/${sessionId}.jsonl`, bytes: 1, sha256: 'a'.repeat(64) },
    };
  }
  if (value.gsd_role && !result.gsd_agent_evidence) {
    result.gsd_agent_evidence = {
      schema: 'shipyard.gsd-agent-application.v1',
      runtime: 'claude',
      role: value.gsd_role,
      session_id: sessionId,
      session_start_agent_type: value.gsd_role,
      transcript_agent_setting: value.gsd_role,
      agent_setting_records: 1,
    };
  }
  return result;
}

function observedCapabilities(capabilities) {
  return { ...capabilities, observedModel: true, observedEffort: true };
}

module.exports = Object.freeze({ nativeModel, transcriptEvidence, observedCapabilities });
