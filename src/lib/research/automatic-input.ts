import { AUTOMATIC_RESEARCH_LIMITS, type AutomaticResearchInput } from './automatic-contract';
import { ResearchServiceError } from './service';
import { VIDEO_LIMITS } from '../video/ingest';

export async function parseAutomaticForm(form: FormData): Promise<AutomaticResearchInput> {
  const kind = form.get('kind');
  const keys = kind === 'topic' ? ['kind', 'topic'] : kind === 'video' ? ['kind', 'video', 'rights'] : [];
  if (!keys.length || [...form.keys()].some(key => !keys.includes(key)) || keys.some(key => form.getAll(key).length !== 1)) throw new ResearchServiceError(400, 'INVALID_INPUT', 'Supply exactly one topic or one video.');
  if (kind === 'topic') {
    const topic = form.get('topic');
    if (typeof topic !== 'string' || topic.trim().length < 5 || topic.trim().length > AUTOMATIC_RESEARCH_LIMITS.topicCharacters) throw new ResearchServiceError(400, 'INVALID_TOPIC', 'Enter a topic or question between 5 and 500 characters.');
    return { kind, topic: topic.trim() };
  }
  if (process.env.CONTEXTTRAIL_MEDIA_LOCAL !== '1') throw new ResearchServiceError(503, 'LOCAL_MEDIA_DISABLED', 'The local video decoder must be explicitly enabled before a video investigation.');
  if (form.get('rights') !== 'user_provided') throw new ResearchServiceError(400, 'RIGHTS_REQUIRED', 'Confirm you may supply the video and send its representative frame to SerpApi / Google Lens.');
  const video = form.get('video');
  if (!(video instanceof Blob) || !video.size || video.size > VIDEO_LIMITS.bytes) throw new ResearchServiceError(413, 'INVALID_VIDEO', 'Supply one nonempty video no larger than 32 MB.');
  const bytes = new Uint8Array(await video.arrayBuffer());
  const mov = bytes.length >= 12 && String.fromCharCode(...bytes.slice(4, 8)) === 'ftyp';
  const webm = bytes.length >= 4 && bytes[0] === 26 && bytes[1] === 69 && bytes[2] === 223 && bytes[3] === 163;
  if (!mov && !webm) throw new ResearchServiceError(415, 'INVALID_VIDEO', 'Use a self-contained MP4, MOV, WebM or MKV video. Playlists and remote video URLs are not accepted.');
  return { kind: 'video', bytes, rights: 'user_provided' };
}
