/** Independently inspected reference registry. Never imported by production selection. */
export interface TopicReference {
  id: string;
  question: string;
  url: string;
  title: string;
  inspectedOn: string;
  publicationDate: string | null;
  pageLastUpdated: string | null;
  relevanceNote: string;
  /** Explicitly synthetic adapter text, not a captured publisher quotation. */
  syntheticPassage: string;
  syntheticLead: string;
}
export const TOPIC_REFERENCES: TopicReference[] = [
  {
    id: 'isro-reforms', question: 'Is ISRO being privatised? What changed in August–September 2026?',
    url: 'https://www.isro.gov.in/Clarification_regarding_media_reports.html',
    title: 'Clarification regarding media reports on concerns relating to Space Sector Reforms and the role of ISRO',
    inspectedOn: '2026-10-02', publicationDate: '2026-09-06', pageLastUpdated: null,
    relevanceNote: 'First-party statement addresses privatisation claims and distinguishes institutional responsibilities from industry participation. This establishes a reference document, not independent truth.',
    syntheticLead: 'Controlled lead: ISRO privatisation clarification statement about institutional reform and industry participation.',
    syntheticPassage: 'Synthetic benchmark passage: ISRO privatisation and institutional reform are the subject of this controlled policy statement. It distinguishes public research responsibilities from industrial participation. This passage is synthetic test input and is not a quotation captured from the publisher.',
  },
  {
    id: 'nasa-clps', question: 'How does NASA use commercial lunar delivery services?',
    url: 'https://www.nasa.gov/commercial-lunar-payload-services/', title: 'Commercial Lunar Payload Services',
    inspectedOn: '2026-10-02', publicationDate: null, pageLastUpdated: '2026-07-06',
    relevanceNote: 'NASA explains commercial delivery of science and technology payloads. The displayed last-updated date is not treated as a publication or event date.',
    syntheticLead: 'Controlled lead: NASA commercial lunar delivery services program overview.',
    syntheticPassage: 'Synthetic benchmark passage: NASA commercial lunar delivery services are described in this controlled program overview. The document discusses commercial payload delivery and public scientific responsibilities. This passage is synthetic test input and is not a quotation captured from the publisher.',
  },
  {
    id: 'boe-policy', question: 'What monetary policy tools does the Bank of England use?',
    url: 'https://www.bankofengland.co.uk/monetary-policy', title: 'Monetary policy',
    inspectedOn: '2026-10-02', publicationDate: null, pageLastUpdated: null,
    relevanceNote: 'The central bank describes Bank Rate and quantitative easing as monetary policy tools. No publication date was established from the inspected page.',
    syntheticLead: 'Controlled lead: Bank of England monetary policy statement explaining its tools.',
    syntheticPassage: 'Synthetic benchmark passage: Bank of England monetary policy tools are explained in this controlled policy statement. It discusses interest-rate policy and bond purchases while leaving factual verification to the reader. This passage is synthetic test input and is not a quotation captured from the publisher.',
  },
];
