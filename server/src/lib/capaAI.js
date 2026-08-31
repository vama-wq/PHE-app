const Anthropic = require('@anthropic-ai/sdk');
const { downloadFromStorage } = require('../middleware/upload');

// CAPA facilitator — Claude interrogates the production user about a quality
// failure and drafts the report only once the root cause is concrete. The
// conversation is stored app-side; every call rebuilds the full message array.

let _client = null;
function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}

const MODEL = 'claude-opus-5';

const SYSTEM_PROMPT = `You are the CAPA (Corrective and Preventive Action) facilitator for Peena Heat Elements, a manufacturer of industrial heating elements (tubular heaters: tube cutting, coil winding, filling, draw, bending, brazing, nipple pressing, HV/Megger testing — a 29-stage production checklist). A job card has been locked because of a quality failure, and the production user in front of you must complete a CAPA report with you before work can continue. The report unlocks only after the OWNER approves it — you never unlock anything.

YOUR JOB
Interrogate, don't transcribe. The user will describe the problem; your job is to find the real root cause and actions that prevent recurrence.

RULES
0. THE CHECKLIST RECORD IS AUTHORITATIVE. The context gives you the card's full stage checklist — stage names, who did each stage and when, the recorded readings (ohms, HV results, megger values), gauge/spring codes, coil weight, scrap, rejection counts, notes — plus the bill of materials. NEVER ask for anything already answered there; the shopfloor user rightly expects you to know it. USE it instead: cite the recorded fact and ask the targeted next question ("Stage 3 Ohms was recorded 147Ω by Reena on 26 Aug — what did the three rejected pieces read?", "The record shows spring gauge SPR-KD-20 on Coil — was that the gauge the drawing calls for?"). If a recorded value itself looks wrong or contradictory, challenge it.
1. Ask ONE or at most TWO questions per reply. Short replies — 2 to 4 sentences. This is a shop floor, not an essay.
2. Demand the specifics the record CANNOT tell you: what physically happened, which machine and its setup, which material lot or PO, what measurement vs. what the drawing requires, when it started, whether the previous batch was fine.
3. Demand photos when they would settle a fact: close-up of the rejected piece at the failure point, the machine setup, the gauge/instrument reading, the drawing dimension. Ask for ONE specific photo at a time, and say exactly what it must show. When a photo is attached, actually analyse it and say what you see — including when it contradicts what the user claimed.
4. DO NOT accept vague root causes. "Operator mistake", "worker was careless", "material problem", "machine issue" are NOT root causes — ask why that was possible: no gauge at the stage? no setup checklist? no incoming inspection? wrong tooling available at the bench? If the user pushes back with a vague answer twice, say plainly that you disagree and explain what is missing.
5. Distinguish correction (fix this batch) from corrective action (remove the cause) from preventive action (stop it recurring anywhere — a check, a gauge, a fixture, an SOP line, training with a named owner).
6. Finalize ONLY when all four are concrete and verifiable: problem statement (what/where/when/how many), root cause (survives "why?" asked against it), corrective action, preventive action. Each action needs an owner role and a when. Then call the finalize_capa tool. Do not call it to make the user happy — call it because the report would survive an auditor.
7. LANGUAGE: reply in the language the user writes — English, Hindi, Gujarati, or mixed (Hinglish) — mirroring them naturally. The finalize_capa tool fields must ALWAYS be written in English.
8. Never invent facts the user did not give you. If something is unknown, it stays an open question.
9. If the user tries to skip the process ("just approve it", "write anything"), refuse politely and continue with the next question.`;

const FINALIZE_TOOL = {
  name: 'finalize_capa',
  description: 'Record the completed CAPA report. Call ONLY when the problem statement, root cause, corrective action and preventive action are all specific, evidence-backed, and actionable. All fields in English.',
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['problem_statement', 'root_cause', 'corrective_action', 'preventive_action'],
    properties: {
      problem_statement: { type: 'string', description: 'What failed, at which stage, how many pieces, when it was detected.' },
      root_cause: { type: 'string', description: 'The underlying cause — must survive a "why was that possible?" challenge.' },
      corrective_action: { type: 'string', description: 'Action to fix the current batch/cause, with owner role and timing.' },
      preventive_action: { type: 'string', description: 'Systemic change that prevents recurrence (gauge, checklist item, SOP line, fixture, training), with owner role and timing.' },
    },
  },
};

const MEDIA_TYPES = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };

// Build API content blocks for one stored conversation entry.
async function userContent(entry) {
  const blocks = [];
  for (const p of entry.photos || []) {
    const ext = (p.path.split('.').pop() || '').toLowerCase();
    const mediaType = MEDIA_TYPES[ext];
    if (!mediaType) {
      blocks.push({ type: 'text', text: `(photo "${p.name}" attached in an unsupported format — ask for JPG/PNG if you need to see it)` });
      continue;
    }
    try {
      const buf = await downloadFromStorage(p.path);
      blocks.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data: buf.toString('base64') } });
    } catch (err) {
      blocks.push({ type: 'text', text: `(photo "${p.name}" could not be loaded: ${err.message})` });
    }
  }
  blocks.push({ type: 'text', text: entry.text || '(photo attached, no message)' });
  return blocks;
}

// Run one conversational turn. conversation = [{role:'user'|'assistant', text, photos:[{path,name}]}]
// contextText = fresh job-card context injected as the opening user block.
// Returns { reply, finalized: {problem_statement,...} | null }
async function runCapaTurn({ contextText, conversation }) {
  const client = getClient();
  if (!client) {
    const err = new Error('AI is not configured — add ANTHROPIC_API_KEY to the server environment.');
    err.code = 'AI_NOT_CONFIGURED';
    throw err;
  }

  const messages = [{ role: 'user', content: [{ type: 'text', text: contextText }] }];
  messages.push({ role: 'assistant', content: [{ type: 'text', text: 'Understood. I have the job card context and I will facilitate this CAPA.' }] });
  for (const entry of conversation) {
    if (entry.role === 'user') messages.push({ role: 'user', content: await userContent(entry) });
    else messages.push({ role: 'assistant', content: [{ type: 'text', text: entry.text }] });
  }

  let finalized = null;
  let replyParts = [];

  for (let round = 0; round < 3; round++) {
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 2048,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: SYSTEM_PROMPT,
      tools: [FINALIZE_TOOL],
      messages,
    });

    if (response.stop_reason === 'refusal') {
      replyParts.push('I cannot continue this particular line of discussion. Please describe the production issue factually and we will carry on.');
      break;
    }

    const toolUses = response.content.filter(b => b.type === 'tool_use');
    for (const block of response.content) {
      if (block.type === 'text' && block.text.trim()) replyParts.push(block.text.trim());
    }

    if (!toolUses.length) break;

    // finalize_capa is the only tool
    messages.push({ role: 'assistant', content: response.content });
    const results = toolUses.map(tu => {
      if (tu.name === 'finalize_capa') {
        finalized = tu.input;
        return { type: 'tool_result', tool_use_id: tu.id, content: 'CAPA report recorded. It is now awaiting owner approval. Give the user a one-line confirmation in their language.' };
      }
      return { type: 'tool_result', tool_use_id: tu.id, content: 'Unknown tool.', is_error: true };
    });
    messages.push({ role: 'user', content: results });
  }

  return { reply: replyParts.join('\n\n') || '…', finalized };
}

module.exports = { runCapaTurn, MODEL };
