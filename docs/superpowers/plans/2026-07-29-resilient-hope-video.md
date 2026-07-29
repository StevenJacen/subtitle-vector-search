# Resilient Hope Video Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce and verify one vertical five-scene video about choosing to move forward through adversity.

**Architecture:** Use the existing localhost workbench as the orchestration boundary. The workbench selects a continuous subtitle passage from Supabase, asks Ollama for bilingual visual planning, retrieves Vecteezy candidates for explicit review, records selections and production metadata in Supabase, downloads confirmed sources, and renders the silent MP4 locally with FFmpeg.

**Tech Stack:** TypeScript workbench, Supabase Edge Functions, Ollama, Vecteezy API, FFmpeg, ffprobe, Playwright-compatible browser control.

## Global Constraints

- Theme: `Choosing to move forward through adversity`.
- Use exactly five consecutive cues from one ready subtitle track.
- Render vertical `9:16` at 1080x1920, H.264, yuv420p, 30 fps.
- Use eight Vecteezy candidates per scene and explicitly confirm one per scene.
- Preserve exact English dialogue and add concise Chinese subtitles.
- Add no narration, music, ambience, source audio, logos, or watermarks.
- Target a final duration of 25-40 seconds.
- Use at most five formal provider downloads for the initial production.

---

### Task 1: Production Preflight

**Files:**
- Read: `.env`
- Read: `src/workbench/server.ts`
- Read: `src/workbench/health.ts`

**Interfaces:**
- Consumes: `GET /api/health`
- Produces: a reachable workbench URL with Supabase, Ollama, FFmpeg, ffprobe, font, and disk checks available

- [ ] **Step 1: Confirm the live workbench is reachable**

Run:

```powershell
Invoke-RestMethod -Uri 'http://127.0.0.1:4174/api/health' | ConvertTo-Json -Depth 8
```

Expected: HTTP 200. Supabase, Ollama, FFmpeg, ffprobe, font, and disk report `ok`; Vecteezy may report `degraded` only when its quota headers are unavailable.

- [ ] **Step 2: Confirm there is no active production task**

Open `http://127.0.0.1:4174/` and inspect task history. Do not start a second production while another task is downloading, probing, or rendering.

### Task 2: Create the Five-Scene Task

**Files:**
- Create at runtime: `artifacts/video-runs/$taskId/manifest-v2.json`
- Create at runtime: `artifacts/video-runs/$taskId/review-state.json`

**Interfaces:**
- Consumes: `POST /api/tasks` with `{ theme, aspectRatio: "9:16", sceneCount: 5 }`
- Produces: a review-stage task containing one continuous five-cue passage and eight candidates per scene

- [ ] **Step 1: Create the task in the workbench**

Enter:

```text
Choosing to move forward through adversity
```

Select `9:16`, keep the scene count at `5`, and create the task.

- [ ] **Step 2: Validate the selected passage**

Confirm the passage:

- comes from one movie and one subtitle track;
- contains exactly five consecutive cue indexes;
- lasts 25-40 seconds in total;
- has a coherent emotional progression rather than five unrelated fragments.

If any condition fails, discard the unproduced task and create a fresh task with the same theme.

- [ ] **Step 3: Validate bilingual planning**

Confirm each scene has exact English dialogue, a concise Chinese translation, and a visual concept that can be represented by generic stock footage.

### Task 3: Review and Confirm Visual Sources

**Files:**
- Modify at runtime: `artifacts/video-runs/$taskId/manifest-v2.json`
- Modify at runtime: `artifacts/video-runs/$taskId/review-state.json`

**Interfaces:**
- Consumes: eight preview candidates per scene
- Produces: one explicitly selected and confirmed candidate per scene

- [ ] **Step 1: Review all five candidate grids**

For each scene, compare visible subject, movement, framing, duration, orientation, and relationship to the dialogue. Reject candidates with watermarks, logos, illegible previews, duplicate footage, or weak thematic connection.

- [ ] **Step 2: Preserve the intended progression**

Select footage in this sequence:

1. enclosed or obstructed environment;
2. uncertainty or solitary reflection;
3. visible decision or preparation;
4. forward physical movement;
5. wide, bright, open environment.

- [ ] **Step 3: Confirm exactly one candidate per scene**

Use the workbench selection and confirmation controls. Production must remain disabled until all five scenes show a current confirmed selection.

### Task 4: Download and Render

**Files:**
- Create at runtime: `artifacts/video-runs/$taskId/sources/`
- Create at runtime: `artifacts/video-runs/$taskId/subtitles.ass`
- Create at runtime: `artifacts/video-runs/$taskId/final.mp4`

**Interfaces:**
- Consumes: five confirmed scene selections
- Produces: a completed `WorkbenchTaskView` with a local final MP4 and recorded Supabase metadata

- [ ] **Step 1: Start production once**

Click the production command once. Do not repeat it while the task is downloading, probing, normalizing, rendering, or finalizing.

- [ ] **Step 2: Monitor the stage**

Wait for `completed`. If the task reports a retryable failure, use the workbench recovery command. If a source is deterministically rejected, return to review and replace only that scene within the remaining formal-download budget.

- [ ] **Step 3: Record the final task identifier and output path**

Read the completed task response and resolve:

```text
artifacts/video-runs/$taskId/final.mp4
```

### Task 5: Technical and Visual Verification

**Files:**
- Read: `artifacts/video-runs/$taskId/final.mp4`
- Read: `artifacts/video-runs/$taskId/subtitles.ass`
- Create temporarily: `artifacts/video-runs/$taskId/verification/`

**Interfaces:**
- Consumes: completed MP4
- Produces: verified media metadata and representative frame images

- [ ] **Step 1: Probe media metadata**

Run:

```powershell
ffprobe -v error -show_streams -show_format -of json "artifacts/video-runs/$taskId/final.mp4"
```

Expected: 1080x1920, H.264, yuv420p, 30 fps, no audio stream, and 25-40 seconds total duration.

- [ ] **Step 2: Extract representative frames**

Run five `ffmpeg -ss` frame extractions distributed across the actual duration and save them under `artifacts/video-runs/$taskId/verification/`.

- [ ] **Step 3: Inspect the frames**

Confirm every frame is nonblank, fills the portrait canvas, contains readable nonoverlapping bilingual subtitles, and demonstrates visual progression across the five scenes.

- [ ] **Step 4: Report the artifact**

Return the absolute final MP4 path, duration, dimensions, codec, file size, selected movie, exact subtitle interval, and any remaining visual caveats.
