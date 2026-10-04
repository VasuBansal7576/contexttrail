import { AUTOMATIC_RESEARCH_LIMITS, type AutomaticResearchInput } from './automatic-contract';
import { ResearchServiceError } from './service';
import { VIDEO_LIMITS } from '../video/ingest';
import { hasSelfContainedMovLayout } from '../video/container-signature';

export async function parseAutomaticForm(form: FormData): Promise<AutomaticResearchInput> {
  const kind = form.get('kind');
  const keys = kind === 'topic' ? ['kind', 'topic'] : (kind === 'video' || kind === 'audio') ? ['kind', kind, 'rights'] : [];
  const allowedKeys = (kind === 'video' || kind === 'audio') ? [...keys, 'claim'] : keys;
  if (!keys.length || [...form.keys()].some(key => !allowedKeys.includes(key)) || keys.some(key => form.getAll(key).length !== 1) || form.getAll('claim').length > 1) throw new ResearchServiceError(400, 'INVALID_INPUT', 'Supply exactly one question, video or audio file.');
  if (kind === 'topic') {
    const topic = form.get('topic');
    if (typeof topic !== 'string' || topic.trim().length < 5 || topic.trim().length > AUTOMATIC_RESEARCH_LIMITS.topicCharacters) throw new ResearchServiceError(400, 'INVALID_TOPIC', 'Enter a topic or question between 5 and 500 characters.');
    return { kind, topic: topic.trim() };
  }
  if (process.env.CONTEXTTRAIL_MEDIA_LOCAL !== '1') throw new ResearchServiceError(503, 'LOCAL_MEDIA_DISABLED', 'The local video decoder must be explicitly enabled before a media investigation.');
  if (form.get('rights') !== 'user_provided') throw new ResearchServiceError(400, 'RIGHTS_REQUIRED', 'Confirm you may supply this media and send visual or recognized speech leads to the search and assessment providers.');
  const caption = form.get('claim');
  if (caption !== null && (typeof caption !== 'string' || caption.trim().length > 500)) throw new ResearchServiceError(400, 'INVALID_CAPTION', 'Use a caption of at most 500 characters.');
  const claim = typeof caption === 'string' && caption.trim() ? caption.trim() : null;
  const video = form.get(String(kind));
  if (!(video instanceof Blob) || !video.size || video.size > VIDEO_LIMITS.bytes) throw new ResearchServiceError(413, 'INVALID_VIDEO', 'Supply one nonempty media file no larger than 32 MB.');
  const bytes = new Uint8Array(await video.arrayBuffer());
  if (kind === 'audio') {
    const ascii = (start: number, count: number) => new TextDecoder().decode(bytes.slice(start, start + count));
    const audio = ascii(0, 4) === 'fLaC' || ascii(0, 4) === 'OggS' || (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WAVE') || ascii(0, 3) === 'ID3' || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) || hasSelfContainedMovLayout(bytes);
    if (!audio) throw new ResearchServiceError(415, 'INVALID_AUDIO', 'Use a self-contained WAV, MP3, FLAC, Ogg or M4A file. Remote URLs and playlists are excluded.');
    return { kind, bytes, rights: 'user_provided', claim };
  }
  const mov = hasSelfContainedMovLayout(bytes);
  const webm = bytes.length >= 4 && bytes[0] === 26 && bytes[1] === 69 && bytes[2] === 223 && bytes[3] === 163;
  if (!mov && !webm) throw new ResearchServiceError(415, 'INVALID_VIDEO', 'Use a self-contained MP4, MOV, WebM or MKV video. Playlists and remote video URLs are not accepted.');
  return { kind: 'video', bytes, rights: 'user_provided', claim };
}
