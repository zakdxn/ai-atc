# AI ATC: the voice-to-intent endpoint

This is the small server that lets the pilots understand open-ended speech.
The game sends it a transmission plus the current traffic picture; it asks
Groq to turn that into structured intents and sends them back.

It exists for one reason: **the Groq API key must never be in the game.**
`engine.js` is downloaded by every visitor, so a key in it is readable from
view-source. It lives here instead, as a Worker secret.

## How the parser is wired

The game's built-in grammar runs **first** and handles standard phraseology
with no network call at all. This endpoint is consulted only when:

- nothing in the transmission was recognised,
- the game could not work out which aircraft you meant, or
- it understood part of the transmission and there was text left over.

So a normal "runway 27R, cleared for takeoff" is instant and costs nothing.
"Slow the heavy on final and bring him around for another look" comes here.

If this endpoint is missing, slow, erroring or returns nothing, the game
falls back to its grammar. A dead endpoint never costs you a transmission.

---

## Setup

You need a free Cloudflare account and a Groq API key. There are two ways to
deploy the Worker: **the dashboard** (a website, no installs, recommended if
you don't already have Node/Wrangler set up) or **the command line** (faster
if you do). Both end up in the same place. Do one, not both.

### 1. Get a Groq key

Sign in at <https://console.groq.com>, create an API key, copy it somewhere
safe for a minute — Groq only shows it to you once.

### 2a. Deploy via the dashboard (no command line)

1. Go to <https://dash.cloudflare.com>, sign up free if you don't have an
   account, and open **Workers & Pages** in the left sidebar.
2. Click **Create**, then **Create Worker**. Give it a name (e.g.
   `ai-atc-parse` — this becomes part of the URL) and click **Deploy** to
   create it with the placeholder "Hello World" code; you'll replace that
   next.
3. Click **Edit code** to open the in-browser editor. Delete everything in
   it, then paste in the entire contents of this repo's `parse.js` (copy it
   from [the file on
   GitHub](https://github.com/zakdxn/ai-atc/blob/claude/simulator-bugs-improvements-54zvvb/parse.js) —
   use whichever branch is current for you once this is merged to `main`).
   Click **Deploy** again to save it.
4. Go to the Worker's **Settings** tab, then **Variables and Secrets**. Add
   three:
   - `GROQ_API_KEY` — paste your Groq key, and mark it **Secret** (encrypted,
     never shown again after you save).
   - `GROQ_MODEL` — plain text, value `openai/gpt-oss-20b`.
   - `ALLOWED_ORIGINS` — plain text, see step 4 below for what to put here.
   Save/deploy after adding them.
5. The Worker's URL is shown at the top of its dashboard page, something like
   `https://ai-atc-parse.YOUR-SUBDOMAIN.workers.dev`. Keep it.

### 2b. Deploy via the command line, instead of 2a

From the repo root (`parse.js` and `wrangler.toml` live here, no separate
`worker/` subdirectory):

```sh
npx wrangler login
npx wrangler deploy
npx wrangler secret put GROQ_API_KEY
```

`wrangler login` opens a browser tab to authorize; `deploy` prints the URL
it deployed to; `secret put` prompts you to paste the key (stored encrypted,
never in the repo). `GROQ_MODEL` and `ALLOWED_ORIGINS` are already in
`wrangler.toml` as plain vars — edit them there and run `npx wrangler deploy`
again to pick up changes, rather than `secret put` (that command is only for
values meant to stay encrypted, like the API key).

### 3. Tell it which origins may call it

`ALLOWED_ORIGINS` is a comma-separated allowlist of exactly the origins
(scheme + host, no path, no trailing slash) the Worker will accept calls
from — it's a CORS check, not a real security boundary, but it stops casual
misuse of your Groq quota from other sites. If the game is live at
`https://zakdxn.github.io/ai-atc/`, the origin is `https://zakdxn.github.io`.
Not live anywhere yet? Use `*` for now (allow anything) and tighten it once
you know the real URL — a wrong-but-specific value just means the Worker
silently refuses every call and the game falls back to its grammar, not a
crash, but you won't get AI parsing until it's fixed.

### 4. Point the game at it

In the browser console, on the game page:

```js
aiParser(true, "https://ai-atc-parse.YOUR-SUBDOMAIN.workers.dev")
```

To make it the default, set it in `engine.js`:

```js
const AI_PARSER = {
  enabled: true,
  url: "https://ai-atc-parse.YOUR-SUBDOMAIN.workers.dev",
  ...
};
```

That URL is fine to commit. The key is not, and is not here.

### 5. Check it

```js
AI_PARSER.debug = true;
```

Then say something the grammar will not know, like *"give me a three sixty
for spacing"*. The comms log will show how long the call took and how many
intents came back. `AI_PARSER.lastMs` holds the most recent timing.

---

## Running locally instead

If you would rather keep everything on your machine, serve the game over
`http://localhost` and run any endpoint you like there:

```js
aiParser(true, "http://localhost:5000/parse")
```

**This only works when the game is also on `http://localhost`.** An HTTPS page
cannot call `http://localhost` — the browser blocks it as mixed content. So
this is for local development, not for the deployed site.

---

## Choosing a model

`GROQ_MODEL` in `wrangler.toml` defaults to `openai/gpt-oss-20b`. This job is
short structured extraction, not conversation, so a small fast model is the
right pick and a large one mostly buys latency — but earlier testing on this
project found `llama-3.1-8b-instant` (Groq's old small model, deprecated
June 2026 and shut off entirely by mid-August 2026) too unreliable at
following the JSON schema, so if you see the model ignoring `hdg`/`alt`/`spd`
or otherwise mangling the response shape, switch `GROQ_MODEL` to
`openai/gpt-oss-120b` — slower, but far more consistent about sticking to
the schema. It is a plain var, not a secret: edit `GROQ_MODEL` in
`wrangler.toml` and run `npx wrangler deploy` again to pick it up.

**Groq's model lineup changes over time — verify the current ID against
<https://console.groq.com/docs/models> before you rely on it.** If the model
name is wrong the Worker returns an empty intent list with an `error` field,
the game falls back to its grammar, and nothing breaks — but you will not
get any AI parsing until it is fixed. Turn on `AI_PARSER.debug` and watch for
a `groq 404` (unknown model) or `groq 400` (deprecated/decommissioned).

---

## Cost and abuse

Any public endpoint in front of a paid API can be called by anyone who finds
the URL. The `ALLOWED_ORIGINS` check stops casual misuse from a browser, but
it reads the `Origin` header, which a script can set to anything. Treat it as
tidiness, not security.

If that matters to you, add the daily cap:

```sh
npx wrangler kv namespace create ATC_KV
```

Uncomment the `[[kv_namespaces]]` block in `wrangler.toml`, paste in the id
it printed, set `DAILY_CAP` to a number you are comfortable with, and
redeploy. Past that many calls in a day the Worker returns an empty list and
the game quietly falls back to its grammar. Cloudflare's dashboard can also
rate limit per IP if you want a second layer.

Calls only happen on transmissions the grammar could not handle, so normal
play generates far fewer than you would expect.

---

## The contract

**Request**

```json
{
  "transcript": "slow the heavy on final and give him a three sixty",
  "addressee": "DAL484",
  "handled": ["dct"],
  "context": {
    "facility": "KATL", "position": "APP", "zulu": "0315",
    "arrRwy": "27R", "depRwy": "26L",
    "atis": { "letter": "Bravo", "windDir": 240, "windSpd": 14, "altimeter": "2990" },
    "aircraft": [
      { "callsign": "DAL484", "type": "B739", "heavy": false, "role": "arr",
        "state": "appCtl", "altitude": 4000, "speed": 210, "heading": 270,
        "runway": "27R", "milesOut": 8.2, "gate": null,
        "destination": null, "origin": "KDFW", "selected": true }
    ]
  }
}
```

`addressee` is who the game already decided you were talking to, or null.
`handled` lists actions already applied, so the model returns only what is
outstanding.

**Response**

```json
{ "intents": [ { "callsign": "UAL22", "action": "spd", "value": "180" } ] }
```

Always HTTP 200 with a valid shape, even on failure — an empty `intents`
array is how the endpoint says "no idea", and the game handles that cleanly.

**Actions**

```
hdg alt spd seq dct ils taxi cto ctl luaw expect push hold cont
abort ga stby rgr ho exit rbok rbbad monitor dvs rns none
```

Anything else is still accepted: the pilot acknowledges it and the comms log
records that nothing on the scope changed. That is deliberate, so a plausible
reply never hides the fact that no state moved.

`parse.js` keeps the action list in `ACTIONS` and the instructions in
`SYSTEM_PROMPT`. If you add an op to `AI_ACTIONS` in `engine.js`, add it in
both places here too.
