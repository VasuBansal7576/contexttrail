import type { Metadata } from 'next';
import { VideoCompare } from '@/components/casebook/VideoCompare';

export const metadata: Metadata = { title: 'Compare supplied media · ContextTrail', description: 'Inspect candidate overlaps between sampled frames from files you supply.' };
export default function ComparePage() { return <VideoCompare />; }
