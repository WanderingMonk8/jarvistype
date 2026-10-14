import assert from 'node:assert/strict'
import test from 'node:test'

import {
  appendRecordingTranscript,
  applyManualEdit,
  createDraftSession,
  joinRecordingTranscript,
  restoreDraftSession,
  undoLatestDraftMutation,
  undoLastRecording,
} from '../src/domain/draft-session'

function idSequence(...ids: string[]): () => string {
  let index = 0
  return () => ids[index++] ?? `generated-${index}`
}

test('numbers only non-empty paragraphs and preserves blank separators in clean text', () => {
  const result = applyManualEdit(createDraftSession('chat-1'), 'First\n\nSecond\n   \nThird', {
    expectedVersion: 0,
    editGroupId: 'group-1',
    now: '2026-10-13T10:00:00.000Z',
    createId: idSequence('history-1', 'paragraph-1', 'paragraph-2', 'paragraph-3'),
  })

  assert.equal(result.applied, true)
  assert.equal(result.session.cleanText, 'First\n\nSecond\n   \nThird')
  assert.deepEqual(
    result.session.paragraphs.map(({ ordinal, lineIndex, text }) => ({ ordinal, lineIndex, text })),
    [
      { ordinal: 1, lineIndex: 0, text: 'First' },
      { ordinal: 2, lineIndex: 2, text: 'Second' },
      { ordinal: 3, lineIndex: 4, text: 'Third' },
    ],
  )
})

test('retains stable paragraph ids through edits and structural insertion', () => {
  const ids = idSequence('history-1', 'alpha-id', 'beta-id', 'history-2', 'history-3', 'intro-id')
  const first = applyManualEdit(createDraftSession('chat-1'), 'Alpha\n\nBeta', {
    expectedVersion: 0,
    editGroupId: 'group-1',
    createId: ids,
  }).session
  const edited = applyManualEdit(first, 'Alpha edited\n\nBeta', {
    expectedVersion: 1,
    editGroupId: 'group-2',
    createId: ids,
  }).session
  const inserted = applyManualEdit(edited, 'Intro\nAlpha edited\n\nBeta', {
    expectedVersion: 2,
    editGroupId: 'group-3',
    createId: ids,
  }).session

  assert.equal(edited.paragraphs[0]?.id, first.paragraphs[0]?.id)
  assert.equal(edited.paragraphs[1]?.id, first.paragraphs[1]?.id)
  assert.equal(inserted.paragraphs[1]?.id, first.paragraphs[0]?.id)
  assert.equal(inserted.paragraphs[2]?.id, first.paragraphs[1]?.id)
  assert.notEqual(inserted.paragraphs[0]?.id, first.paragraphs[0]?.id)
})

test('increments versions, rejects stale edits, groups typing, and undoes the group', () => {
  const ids = idSequence('history-1', 'paragraph-1', 'paragraph-2', 'undo-history')
  const first = applyManualEdit(createDraftSession('chat-1'), 'H', {
    expectedVersion: 0,
    editGroupId: 'typing-1',
    createId: ids,
  }).session
  const second = applyManualEdit(first, 'Hi', {
    expectedVersion: 1,
    editGroupId: 'typing-1',
    createId: ids,
  }).session
  const stale = applyManualEdit(second, 'stale', {
    expectedVersion: 1,
    editGroupId: 'typing-2',
    createId: ids,
  })
  const undone = undoLatestDraftMutation(second, 2, '2026-10-13T10:01:00.000Z', ids)

  assert.equal(second.draftVersion, 2)
  assert.equal(second.history.length, 1)
  assert.equal(second.canUndo, true)
  assert.equal(stale.applied, false)
  assert.equal(stale.reason, 'stale-version')
  assert.equal(undone.applied, true)
  assert.equal(undone.session.draftVersion, 3)
  assert.equal(undone.session.cleanText, '')
  assert.equal(undone.session.canUndo, false)
  assert.equal(undone.session.history.at(-1)?.kind, 'undo')
})

test('appends recordings in order with conservative boundary whitespace', () => {
  const typed = applyManualEdit(createDraftSession('chat-voice'), 'Typed opening.', {
    expectedVersion: 0,
    editGroupId: 'typing',
    createId: idSequence('typed-history', 'typed-paragraph'),
  }).session
  const first = appendRecordingTranscript(typed, 'First spoken segment.', {
    expectedVersion: 1,
    segmentId: 'segment-1',
    now: '2026-10-14T10:00:00.000Z',
    createId: idSequence('voice-paragraph-1', 'voice-history-1'),
  }).session
  const second = appendRecordingTranscript(first, '\nSecond spoken paragraph.\n', {
    expectedVersion: 2,
    segmentId: 'segment-2',
    now: '2026-10-14T10:01:00.000Z',
    createId: idSequence('voice-paragraph-2', 'voice-history-2'),
  }).session

  assert.equal(second.cleanText, 'Typed opening. First spoken segment.\nSecond spoken paragraph.\n')
  assert.deepEqual(
    second.recordingSegments.map((segment) => segment.id),
    ['segment-1', 'segment-2'],
  )
  assert.equal(second.history.at(-1)?.kind, 'recording-append')
  assert.equal(second.canUndoRecording, true)
  assert.equal(joinRecordingTranscript('Hello ', ' world'), 'Hello world')
  assert.equal(joinRecordingTranscript('Hello', 'world'), 'Hello world')
  assert.equal(joinRecordingTranscript('Hello\n', '\nworld'), 'Hello\n\nworld')
})

test('undo last recording removes only that segment and supports the preceding segment', () => {
  const base = applyManualEdit(createDraftSession('chat-voice'), 'Base', {
    expectedVersion: 0,
    editGroupId: 'typing',
  }).session
  const first = appendRecordingTranscript(base, 'One', {
    expectedVersion: 1,
    segmentId: 'segment-1',
  }).session
  const second = appendRecordingTranscript(first, 'Two', {
    expectedVersion: 2,
    segmentId: 'segment-2',
  }).session
  const undoSecond = undoLastRecording(second, 3)
  const undoFirst = undoLastRecording(undoSecond.session, 4)

  assert.equal(undoSecond.applied, true)
  assert.equal(undoSecond.session.cleanText, 'Base One')
  assert.equal(undoSecond.session.recordingSegments.length, 1)
  assert.equal(undoSecond.session.canUndoRecording, true)
  assert.equal(undoFirst.session.cleanText, 'Base')
  assert.equal(undoFirst.session.recordingSegments.length, 0)
  assert.equal(undoFirst.session.canUndoRecording, false)
})

test('deduplicates recording operation ids and migrates Phase 2 drafts', () => {
  const first = appendRecordingTranscript(createDraftSession('chat-voice'), 'Once', {
    expectedVersion: 0,
    segmentId: 'segment-once',
  }).session
  const duplicate = appendRecordingTranscript(first, 'Once again', {
    expectedVersion: 1,
    segmentId: 'segment-once',
  })
  const legacySource = createDraftSession('legacy-chat')
  const legacy = { ...legacySource, schemaVersion: 1 } as Record<string, unknown>
  delete legacy.recordingSegments
  delete legacy.canUndoRecording
  const migrated = restoreDraftSession(legacy, 'legacy-chat')

  assert.equal(duplicate.applied, false)
  assert.equal(duplicate.session.cleanText, 'Once')
  assert.equal(migrated?.schemaVersion, 2)
  assert.deepEqual(migrated?.recordingSegments, [])
  assert.equal(migrated?.canUndoRecording, false)
})
