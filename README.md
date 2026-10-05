# ContextTrail

*Follow the question.*

An image travels with a new caption. A claim gets repeated until its source disappears. An answer sounds certain, but the evidence is hard to inspect.

ContextTrail gives you a place to investigate and keep the details. Start with a question, claim, image, or local media file. Follow the retrieved sources, read retained passages, compare explanations, and return when something changes.

**[Try ContextTrail](https://contexttrail.zippy17.chatgpt.site)** · **[Watch the 90-second demo](https://youtu.be/iRT1YDrCMDI)**

Built by Vasu for the SerpApi India Hackathon 2026, in the Knowledge & Public Interest track.

## What you can do

- **Investigate a question or claim.** Retrieve sources, inspect what they say, and see support, challenges, context, and gaps tied to retained passages.
- **Follow an image.** Find visual matches and earlier retrieved appearances, with publication dates and caption context kept distinct.
- **Investigate local video and audio.** Inspect sampled frames and timestamped speech, then research usable recognized wording.
- **Keep a casebook.** Save investigations, source anchors, findings, and revision history. Reopen the evidence without repeating a search.
- **Connect and revisit cases.** Compare supplied media, group related retained wording, and check watched questions for new evidence.

The interface connects nine chapters: Cover, Image, Video, Questions, Evidence, Sources, Changes, Watch, and AI answers.

## Try the public app

Open [ContextTrail on ChatGPT Sites](https://contexttrail.zippy17.chatgpt.site) and sign in with ChatGPT to investigate a question or upload an image. Provider keys are configured on the backend. Your saved casebook is private to your account.

The launch trial allows **three investigation attempts per account per UTC day**, subject to a shared provider allowance, through **18 October 2026**. Failed or cancelled runs also consume their reservation. See [trial limits and hosting details](hosting/sites/README.md).

| Capability | Public app | Local app |
| --- | --- | --- |
| Question, claim, and image research | Available | Available with live configuration |
| Saved casebooks | Private to your signed-in account | Stored on your local disk |
| Source page inspection | HTML | HTML and selectable-text PDFs |
| Video, audio, and supplied-media comparison | Run locally | Requires native tools |
| Watched questions | Manual checks | Manual and scheduled checks while the server runs |

## Run locally

Use Node.js 24 and npm. Clone the repository, then start the interface:

```sh
git clone https://github.com/VasuBansal7576/contexttrail.git
cd contexttrail
npm ci
cp .env.example .env.local
npm run dev -- -H 127.0.0.1
```

Open [127.0.0.1:3000](http://127.0.0.1:3000). This starts a keyless preview. Live retrieval, persistent local cases, and native media processing are disabled in the template.

### Enable real investigations

Follow the [local live-usage setup](docs/live-usage.md) to configure your server credentials and finite provider allowance:

- `SERPAPI_API_KEY` for retrieval.
- `TYPESAFE_API_KEY` and `TYPESAFE_MODEL=jev-1.13.0` for structured assessments.
- A persistent usage ledger, verified allocation, and explicit live-operation settings.

Keep credentials in ignored `.env.local`, using server-only names. Keys alone do not enable provider calls. The local app reserves the full bounded allowance before each run.

To save local cases and enable native processing, set these values in `.env.local`. Replace the example path with a persistent directory you control:

```dotenv
CONTEXTTRAIL_RESEARCH_LOCAL=1
CONTEXTTRAIL_MEDIA_LOCAL=1
CONTEXTTRAIL_RESEARCH_DATA_DIR=/absolute/path/to/contexttrail-cases
```

Install FFmpeg and FFprobe for video decoding and media comparison. For speech recognition, install `whisper-cli`, then run:

```sh
node scripts/setup-local-speech.mjs
```

The setup script downloads and verifies the pinned multilingual Whisper small model, about 488 MB. Original audio stays local; recognized wording can be sent to the configured research providers. Restart the app after changing configuration.

For a production build, stop the development server, then run:

```sh
npm run build
npm start -- -H 127.0.0.1
```

## How the evidence is assembled

SerpApi Google Search, Google News, and Google Lens retrieve source leads. ContextTrail reads accessible pages and retains passages with their source URLs and dates. TypeSafe/Jev assesses the relationship between those passages and the investigation. The casebook keeps the evidence available for later inspection.

Search snippets stay distinct from inspected page quotes. Publication dates, retrieval dates, and media offsets retain their own meanings. The earliest retrieved appearance can leave the original publication unresolved, and a model assessment carries uncertainty. Sampled frames establish evidence about those samples; whole-video identity needs additional evidence.

The cover's Earthrise collage is illustrative. Its example captions are separate from investigation results.

## Development

The local application uses Next.js, React, TypeScript, Tailwind CSS, and Framer Motion. The public edition projects the shared UI into a Cloudflare Worker with D1 for account-bound indexes and usage reservations, and private R2 storage for case revisions.

Run the offline checks:

```sh
npm test
npm run typecheck
npm run build
```

These checks do not call live providers. [Verification and release records](docs/release.md) document the separate real browser runs and hosted storage checks.

The main implementation lives in:

- `src/lib/investigation/`: image research, identity, dates, and usage limits.
- `src/lib/research/`: automatic research, saved cases, and watches.
- `src/lib/pages/`: page acquisition and readable evidence extraction.
- `src/lib/serpapi/` and `src/lib/jev/`: provider clients.
- `hosting/sites/`: the public deployment adapter.
- `videos/contexttrail/`: the editable launch-film source.

## Read more

- [Automatic investigations](docs/automatic-investigation.md)
- [Casebook and retained evidence](docs/casebook-interface.md)
- [Precise evidence anchors](docs/precise-evidence-anchors.md)
- [Scheduled watches](docs/automatic-watches.md)
- [Public deployment setup](hosting/sites/README.md)
- [Launch-film source and verification](videos/contexttrail/LAUNCH-README.md)

## Credits and licensing

The cover photograph is credited to NASA / Bill Anders. [Asset credits](docs/assets.md) record the artwork, fonts, and remaining attribution checks. A project-wide software license has not yet been selected. Public repository access does not grant a reuse license.
