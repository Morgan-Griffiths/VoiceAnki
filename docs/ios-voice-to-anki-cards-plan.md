# iOS Voice -> Anki Cards (Whisper + OpenAI) Plan

## Goal

Build an iOS app that:
- records short voice clips with push-to-talk,
- transcribes audio to text,
- generates 1+ Anki cards from the transcript using OpenAI + Anki card guidelines,
- supports both per-clip processing and batch processing,
- supports generating `N` card variants and choosing a preferred version,
- stores choices as feedback/training data to improve future generations.

## Recommended Architecture (MVP)

Use a **thin iOS client + local/remote backend**.

Why:
- keeps `OPENAI_API_KEY` off the device,
- lets you version prompts/guidelines centrally,
- makes logging/experimentation easier,
- simplifies future preference-learning / reranking.

### Components

1. `iOS app` (SwiftUI)
- Push-to-talk audio recording
- Transcript preview/edit
- "Generate cards" action
- Variant chooser UI (`N` candidates)
- Export/send to Anki (later)

2. `Backend API` (Node or Python)
- `/transcribe` (audio -> text)
- `/cards/generate` (text -> structured card candidates)
- `/cards/feedback` (store user preference/rating/edits)
- optional `/jobs/batch/*` for bulk audio imports

3. `Storage`
- SQLite/Postgres for metadata + feedback
- blob storage (audio files / transcript snapshots / exports)
- versioned prompt/guideline templates

## Core User Flows

### 1) Push-to-talk (single clip)
1. Hold button to record.
2. Release to stop.
3. App uploads audio to backend.
4. Backend transcribes (`whisper-1` or `gpt-4o-mini-transcribe`).
5. App shows transcript for quick edit.
6. User taps `Generate`.
7. Backend returns 1 or `N` card candidates (structured JSON).
8. User accepts one / edits / rejects.
9. Feedback is stored.

### 2) Bulk processing
1. Import multiple audio clips (Files app / recordings list).
2. Queue transcription jobs.
3. Review transcripts in a batch queue.
4. Generate cards in batch (with `N` variants optional).
5. Accept/reject/edit cards per item.
6. Export selected cards.

## Card Generation Strategy

Use a **structured output schema** for card candidates (not free-form text).

Suggested generation pipeline:
1. `Transcript cleanup` (optional): fix speech disfluencies without changing meaning.
2. `Fact extraction`: identify atomic facts/concepts.
3. `Card drafting`: produce one or more Anki cards.
4. `Validation`: enforce fields, cloze/QA constraints, length limits, duplicates.
5. `Variant ranking` (optional): model self-rank + user choice.

This is much more reliable than a single prompt that outputs markdown.

## Suggested Card JSON Schema (MVP)

```json
{
  "source_id": "clip_123",
  "transcript": "text...",
  "cards": [
    {
      "candidate_id": "cand_1",
      "card_type": "basic",
      "front": "Question text",
      "back": "Answer text",
      "cloze_text": null,
      "tags": ["topic", "source:voice"],
      "rationale": "Why this is a good card",
      "quality_notes": {
        "atomic": true,
        "answerable": true,
        "avoids_ambiguity": true
      }
    }
  ]
}
```

For cloze cards, use:
- `card_type = "cloze"`
- `cloze_text = "The capital of France is {{c1::Paris}}."`
- `front/back = null` (or keep one canonical representation only)

## Variant Generation (`N` versions)

Two good options:

### Option A: One request returns `N` candidates (recommended first)
- Prompt asks for `N` alternatives.
- Output schema returns `cards[]`.
- Fastest to implement.

Tradeoff:
- candidates can be too similar unless you explicitly ask for diversity.

### Option B: Multi-pass generation + reranker (better quality later)
- Run multiple generations with different seeds/temperatures/prompts.
- Rerank candidates (heuristics + model ranker).
- Show top `N`.

Tradeoff:
- higher cost/latency, better diversity.

## Feedback Loop (What to Save)

Save **every preference event**. This is the most valuable data you’ll collect.

### Minimal feedback schema
- `clip_id`
- `transcript_original`
- `transcript_edited` (if user changed it)
- `prompt_version`
- `guideline_version`
- `generation_model`
- `candidate_set` (all candidates shown)
- `chosen_candidate_id`
- `chosen_final_card` (after user edits)
- `rejected_candidate_ids`
- `user_reason` (optional quick tags: `too vague`, `too long`, `wrong fact`, `bad cloze`)
- `timestamp`

### How to use feedback
- Short term: heuristics and prompt conditioning
  - "User prefers cloze cards for definitions"
  - "User dislikes long backs"
- Medium term: reranker training dataset
  - pairwise preference examples: `(A preferred over B)`
- Long term: fine-tuning / DPO-style preference optimization (if worth it)

For an MVP, do **prompt conditioning + reranking** first. Fine-tuning can come later.

## Prompting Guidelines (Practical)

Have a versioned system prompt that encodes your Anki card quality rules, for example:
- one fact per card when possible (atomicity)
- unambiguous question wording
- concise answers
- preserve factual fidelity to transcript
- prefer cards that are worth reviewing later (not trivial filler)
- generate cloze only when it improves recall testing
- avoid redundant cards

Also include:
- transcript text
- optional transcript edit
- desired card count (`1` or `N`)
- preferred card style (`basic`, `cloze`, `mixed`)
- topic tags/source metadata

## Backend Endpoints (MVP)

### `POST /api/transcribe`
- Input: multipart audio file + metadata
- Output: transcript JSON

```json
{
  "clip_id": "clip_123",
  "transcript": "Today I learned...",
  "language": "en",
  "duration_ms": 18234
}
```

### `POST /api/cards/generate`
- Input: transcript + generation params (`n`, card style, deck, tags)
- Output: structured card candidates

### `POST /api/cards/feedback`
- Input: chosen candidate, edits, ratings, reasons
- Output: `ok`

### `POST /api/jobs/batch`
- Input: list of clip IDs or uploaded files
- Output: job id + status

## iOS App Structure (SwiftUI)

Suggested modules:
- `AudioRecorderService`
- `TranscriptionClient`
- `CardGenerationClient`
- `FeedbackClient`
- `RecordingQueueStore`
- `AnkiExportClient` (later)

Key screens:
- `RecordView` (push-to-talk)
- `TranscriptReviewView`
- `CandidatePickerView`
- `BatchQueueView`
- `SettingsView`

## Push-to-Talk UX Notes

- Start recording on `pressDown`; stop on `pressUp`.
- Show waveform + elapsed time.
- Auto-discard clips shorter than a threshold (e.g. <500ms).
- Allow "lock recording" gesture later (not MVP).
- Let user edit transcript before generating cards.

## Anki Integration Options

### Local-first (easy with Mac / same network)
- iOS app talks to your local backend.
- Backend talks to AnkiConnect (`127.0.0.1:8765`) on the machine running Anki.

### Native iOS export (portable)
- Export `.apkg` or CSV-like intermediate and import later.
- Or sync to your own backend, then desktop pushes to AnkiConnect.

For MVP, keep Anki writing on desktop/backend side.

## Security / Privacy

- Do not ship the OpenAI API key in the iOS app.
- Use backend-issued auth/session tokens.
- Encrypt audio at rest if you keep raw clips.
- Add delete controls for audio/transcripts/feedback.

## Cost / Latency Controls

- Default `N = 1`; only request variants when user asks.
- Cache transcript and candidate generations by transcript hash + prompt version.
- Batch transcriptions when importing many files.
- Add per-request timeouts and retry policy.

## Phased Build Plan

### Phase 1 (MVP, 1-2 weeks)
- Push-to-talk recording
- Single clip transcription
- Generate 1 card
- Review/edit/accept
- Save accepted card JSON locally

### Phase 2
- Generate `N` variants
- Candidate chooser
- Feedback capture
- Batch queue

### Phase 3
- Reranking using feedback
- AnkiConnect export pipeline
- Prompt versioning dashboard / evals

## Good First Cut (Concrete Defaults)

- Transcription model: `gpt-4o-mini-transcribe` (or `whisper-1` if you specifically want Whisper)
- Card generation model: a small/fast GPT-4o family model with structured outputs
- Default `n = 1`, optional `n = 3`
- Card style default: `mixed` (`basic` + `cloze`)
- Store feedback in SQLite first

## Risks / Failure Modes To Plan For

- Transcript hallucinations on noisy audio
- Card generator making facts not present in transcript
- Overly verbose cards
- Duplicate cards from repeated speech
- User edits not captured (losing preference signal)
- Latency spikes when requesting many variants

Mitigations:
- transcript review step
- schema validation + length limits
- duplicate detection (hash / semantic similarity later)
- always log candidate set + final accepted edits

