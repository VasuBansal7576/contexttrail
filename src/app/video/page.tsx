import AutomaticResearch from '@/components/casebook/AutomaticResearch';
import { automaticReadiness } from '@/lib/research/automatic-readiness';
export const dynamic = 'force-dynamic';
export default async function VideoPage() {
  const [readiness, captionReadiness] = await Promise.all([automaticReadiness('video'), automaticReadiness('video',true)]);
  return <AutomaticResearch kind="video" readiness={readiness} captionReadiness={captionReadiness} />;
}
