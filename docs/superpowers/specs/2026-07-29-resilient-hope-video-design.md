# Resilient Hope Video Design

## Goal

Create one short-form video around the theme "Choosing to move forward through adversity" using an exact, continuous passage from one movie in the private subtitle library.

## Editorial Direction

- Use five consecutive dialogue cues from one ready subtitle track.
- Prefer a passage with a clear emotional progression: confinement, uncertainty, decision, movement, and release.
- Preserve the English dialogue exactly as stored.
- Add concise Chinese translations beneath the English subtitles.
- Use no narration, music, ambience, or source audio.

## Visual Direction

- Render in vertical 9:16 format.
- Let each scene duration follow its selected cue duration.
- Retrieve eight Vecteezy candidates for each scene.
- Select footage with a strong literal or emotional relationship to the dialogue.
- Progress from enclosed, low-light imagery toward wider, brighter environments.
- Avoid recognizable movie footage, logos, watermarks, and purely decorative imagery.

## Production Flow

1. Search the private subtitle library with the theme.
2. Choose one five-cue continuous passage lasting approximately 25-40 seconds.
3. Generate bilingual scene plans with Ollama.
4. Retrieve eight candidates per scene and review the previews.
5. Explicitly select and confirm one candidate per scene.
6. Download the five selected sources through the approved provider workflow.
7. Render H.264, yuv420p, 30 fps video with bilingual hard subtitles and no audio stream.
8. Verify duration, dimensions, codecs, subtitle visibility, and nonblank frames.
9. Retain source, selection, render, and output metadata in the existing local and Supabase workflow.

## Completion Criteria

- A playable local MP4 exists under `artifacts/video-runs/<task-id>/final.mp4`.
- The video contains five visually distinct scenes and readable bilingual subtitles.
- The final duration follows the selected dialogue and remains within 25-40 seconds.
- Every selected source has a confirmed review record.
- FFmpeg and visual verification complete without errors.
