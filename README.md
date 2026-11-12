# Darkroom

An image generator for [OrcaRouter](https://www.orcarouter.ai/) that runs entirely in your browser. There is no server: your key and prompts go straight from the browser to `api.orcarouter.ai` and nowhere else.

Works on phones and computers, in a dark theme (default) and a light one.

## Models

| Model | OrcaRouter id | Reference images | Shapes | Sizes |
| - | - | - | - | - |
| Nano Banana 2 (Gemini 3.1 Flash Image) | `google/gemini-3.1-flash-image-preview` | up to 14 | 14 ratios, from 1:8 to 8:1, or auto | 0.5K, 1K, 2K, 4K |
| GPT Image 2.5 Flare | `gpt-image-2.5-flare` | up to 16 | 13 ratios up to 3:1, or a custom size | 1K, 2K, 4K, custom |
| GPT Image 2.5 Sunburst | `gpt-image-2.5-sunburst` | up to 16 | same as Flare | same as Flare |

- 1 to 4 images per press.
- GPT options: quality (auto, low, medium, high, xhigh, max), background (auto, opaque, transparent), moderation.
- Gemini option: thinking (minimal or high).
- Custom GPT sizes are checked against OpenAI's rules before sending: both sides a multiple of 16, no side over 3840, at most 3:1, and 655,360 to 8,294,400 pixels in total.
- Each model's id can be edited under More options, in case OrcaRouter renames one.

### How each model is called

- **GPT Image 2.5**: `POST /v1/images/generations`, or `POST /v1/images/edits` (multipart, `image[]` per reference) when references are attached. One request returns all the images.
- **Gemini**: `POST /v1beta/models/google/gemini-3.1-flash-image-preview:generateContent`, Google's native format, with `imageConfig.aspectRatio` and `imageConfig.imageSize`. Gemini returns one image per request, so a batch of 4 is 4 requests in parallel.

## Image quality

Every request asks for PNG, which is lossless. Nothing is re-encoded on the way in or out: the file you download is byte-for-byte what OrcaRouter sent.

The format of each result is read from the file's own bytes, not from what the response claims. A PNG shows a plain `PNG` tag. If a provider sends JPEG or WebP anyway, the tile shows an orange `JPEG, not PNG` tag, the batch gets a note, and the download keeps the real extension (`.jpg`, `.webp`), so you can tell right away.

Reference images over 2048px on the long side are scaled down before upload. Gemini charges the same for any input size and both providers shrink large inputs themselves, so a bigger upload only takes longer.

## Your API key

The default is **This tab only**: the key is kept in memory and nowhere else.

- Never written to localStorage, sessionStorage, cookies, the URL or the page.
- The input field is cleared as soon as the key is read, and it is set up so password managers do not offer to save it.
- Locks itself after 15 minutes without activity (5, 15, 30, 60 or never, in Settings).
- Wiped when you leave the page, so the back button on a shared computer cannot bring it back.
- Cleared at once if OrcaRouter rejects it.
- **Clear this session** in Settings wipes the key, prompt, references and results in one go.

**Remember on this device** is optional, for your own computer only. The key is encrypted with AES-256-GCM, using a key derived from a passphrase you choose (PBKDF2-SHA-256, 600,000 rounds, at least 10 characters). Only the encrypted copy is stored. The passphrase is never stored, and you type it once per visit. This option needs an https page.

The page itself is locked down:

- A Content-Security-Policy that only allows connections to `https://api.orcarouter.ai`, so even injected code could not send the key elsewhere.
- No inline scripts, no `eval`, no third-party scripts, fonts or analytics. Fonts are bundled.
- No `innerHTML`. Text from the API is always shown as text.
- No referrer is sent.
- Refuses to run inside another site's frame.

### What this cannot protect against

On a public or library computer, anything you type can be captured by a keylogger or a malicious browser extension. No web page can prevent that. For public computers:

1. Create a separate key in the OrcaRouter console just for that session.
2. Give it a spend limit.
3. Delete the key when you are done.

## Errors

OrcaRouter's errors are turned into plain messages that say what to do. Some examples: out of credits, a key's own quota or spend limit (with the reset time), a model missing from the key's allowed list, an IP allowlist on the key, a safety block, or Gemini's finish reasons such as `IMAGE_SAFETY`. When OrcaRouter is busy (429 or 503), the request is retried once after a visible countdown. Each error shows OrcaRouter's request id for support.

Source for the mapping: [OrcaRouter errors](https://docs.orcarouter.ai/operations/errors#errors).

## Running it

Needs Node 22.18 or newer.

```bash
npm install
```

```bash
npm run dev
```

Then open the address it prints. `localhost` counts as a secure page, so the remember option works there.

To build for hosting:

```bash
npm run build
```

The `dist` folder is a static site and works from any folder or subpath.

### Publishing on GitHub Pages

The included workflow builds and publishes the site on every push to `main`. To turn it on, go to the repository's **Settings → Pages** and set **Source** to **GitHub Actions**. Pages serves over https, which the remember option needs.

## Tests

```bash
npm test
```

Unit tests for the size rules, error mapping, key cleanup, format detection and response parsing.

```bash
npm run test:e2e
```

Builds the site and drives it in Chromium against a mocked OrcaRouter, with the real Content-Security-Policy in place. It covers both API shapes, references, the non-PNG flag, byte-exact downloads, every error path, retry, cancel, key storage and locking, and layout at 320px, 360px, iPhone and tablet sizes. Screenshots land in `tests/e2e/out/`. It uses the Playwright that is installed globally on the machine.

## Not confirmed against a live key

Request shapes follow OrcaRouter's and the providers' documentation. These were not tried with a real key:

- Whether OrcaRouter's `/v1/images/edits` accepts the 2.5 models. Its docs name `gpt-image-2` for edits.
- Whether the inline cost (`X-OrcaRouter-Include-Cost`) is reported on the image endpoints. It is documented for Gemini's endpoint, and the app shows it when present.

If either fails, the error message from OrcaRouter is shown on the tile.
