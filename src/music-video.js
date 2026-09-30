// Shared by the local server and browser BYOK engine. A music video is a video
// workflow, so it uses the same queue, billing policy and gallery media type.
export const isMusicVideoModel = model => !!model?.audio && (
  /seedance-(?:1[-.]5|2[-.])/i.test(model.id || '') ||
  /kling-(?:v?2[-.]6|v?3(?:[.-]|$)|3\.0)/i.test(model.id || '')
);

const bad = message => Object.assign(new Error(message), { status: 400 });
export function musicVideoSpec(spec, model) {
  if (!isMusicVideoModel(model)) throw bad('Choose a Kling or Seedance model with native audio for a music video.');
  const lyrics = String(spec.lyrics || '').trim();
  if (!lyrics) throw bad('Add the lyrics to sing in this clip.');
  if (lyrics.length > 1200) throw bad('Use a short lyric excerpt (up to 1,200 characters), then make another clip for the next section.');
  const musicStyle = String(spec.musicStyle || '').trim();
  if (musicStyle.length > 500) throw bad('Keep the musical style under 500 characters.');
  const vocals = String(spec.vocals || '').trim().slice(0, 200);
  const bpm = spec.bpm == null || spec.bpm === '' ? undefined : Number(spec.bpm);
  if (bpm !== undefined && (!Number.isInteger(bpm) || bpm < 30 || bpm > 300)) throw bad('Choose a tempo from 30 to 300 BPM.');
  const durations = model.durations || [];
  const duration = spec.duration && spec.duration !== 'auto' ? Number(spec.duration) : durations.includes(10) ? 10 : durations.find(n => n >= 8) || durations[0];
  if (!duration || !durations.includes(duration)) throw bad('Choose a supported clip length for this music video model.');
  if (spec.resolution && spec.resolution !== 'auto' && !model.resolutions?.includes(spec.resolution)) throw bad('Choose a supported resolution.');
  if (spec.aspectRatio && spec.aspectRatio !== 'auto' && !model.aspectRatios?.includes(spec.aspectRatio)) throw bad('Choose a supported aspect ratio.');
  if (spec.audio === false) throw bad('Music videos require audio.');
  return { workflow: 'music-video', lyrics, musicStyle, vocals, bpm, duration, audio: true };
}

export function buildMusicVideoPrompt(scene, spec) {
  return [
    'Create a music performance video with synchronized sung vocals and instrumental music.',
    `Visual direction: ${String(scene || '').trim()}`,
    spec.musicStyle && `Music: ${spec.musicStyle}.`,
    spec.vocals && `Vocal delivery: ${spec.vocals}.`,
    spec.bpm && `Tempo: ${spec.bpm} BPM.`,
    `Perform the following lyrics in order within ${spec.duration} seconds. Sing them, do not speak or narrate them.`,
    `Lyrics:\n${spec.lyrics}`,
    'Match visible mouth movements to the sung words. Keep the referenced performer consistent. No subtitles, captions or on-screen lyrics. End the phrase naturally.'
  ].filter(Boolean).join('\n\n');
}
