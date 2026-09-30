// Customer-query chat: post a message into a query's discussion thread.
//
// Shared by the app route (POST /customer-queries/:id/messages) and the
// WhatsApp reply dispatcher, which calls it directly as the person replying
// (usually the owner answering an @mention). Both paths do exactly the same
// thing: save the message, its attachments and @mentions, move an 'open'
// query to 'in_progress', and alert everyone who was tagged.
//
// fn(db, params) → { ok:true, summary, data } | { ok:false, code, message }
//   code: 'not_found' | 'already_done' | 'invalid' | 'blocked' | 'forbidden'
//
// Posting a message is not a one-shot decision, so there is no 'already_done'
// here: a second post is simply a second message, exactly as in the app. The
// one state change it makes (open → in_progress) is already conditional on
// the query still being 'open', so two posts landing together cannot clash.
const { createNotification } = require('../../routes/notifications');

const MAX_MENTIONS = 25;

const viaSuffix = (via) => (via === 'whatsapp' ? ' (via WhatsApp)' : '');

// Route ids arrive as strings; anything that is not a whole number cannot be
// a query (and would make Postgres throw on the integer column).
function parseId(v) {
  const n = typeof v === 'string' && /^\s*\d+\s*$/.test(v) ? Number(v) : v;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

// Tags: numbers only (a digit string counts), no repeats, never the sender,
// at most MAX_MENTIONS. Accepts the JSON string the app's form sends too.
function cleanMentionIds(raw, selfId) {
  let list = raw;
  if (typeof list === 'string') { try { list = JSON.parse(list); } catch { list = []; } }
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const v of list) {
    const n = parseId(v);
    if (n === null || n === selfId || out.includes(n)) continue;
    out.push(n);
    if (out.length >= MAX_MENTIONS) break;
  }
  return out;
}

// Attachments are already in storage by the time they get here (the app's
// upload middleware puts them there). Accepts multer's file objects
// ({ storagePath, originalname, size, mimetype }) or the plain column names.
function cleanAttachments(list) {
  if (!Array.isArray(list)) return [];
  return list.filter(Boolean).map(f => ({
    file_path: f.storagePath ?? f.file_path ?? null,
    file_name: f.originalname ?? f.file_name ?? null,
    file_size: f.size ?? f.file_size,
    mime_type: f.mimetype ?? f.mime_type,
  }));
}

async function postQueryMessage(db, { queryId, actor, message, mentionIds, via = 'app', attachments } = {}) {
  via = via === 'whatsapp' ? 'whatsapp' : 'app';

  // Same rule as the route: any signed-in user may post in a query thread.
  const actorId = parseId(actor?.id);
  if (!actorId) {
    return { ok: false, code: 'forbidden', message: 'Only a signed-in team member can post in a customer query.' };
  }

  const files = cleanAttachments(attachments);
  if (files.some(f => !f.file_path || !f.file_name)) {
    return { ok: false, code: 'invalid', message: 'One of the attached files did not upload properly — nothing was posted. Please attach it again.' };
  }
  const typed = (message == null ? '' : String(message)).trim();
  if (!typed && !files.length) {
    return { ok: false, code: 'invalid', message: 'Message or attachment required' };
  }

  const qid = parseId(queryId);
  const notFound = { ok: false, code: 'not_found', message: `Customer query #${queryId} was not found — it may have been deleted.` };
  if (!qid) return notFound;

  const sender = await db.get('SELECT id, name, role FROM users WHERE id=$1', [actorId]);
  if (!sender) {
    return { ok: false, code: 'forbidden', message: 'Your user account was not found, so the message was not posted.' };
  }
  const senderName = actor.name || sender.name;

  // Tag only people who exist (a user removed while someone's page was open
  // would otherwise fail the whole post).
  let tagged = [];
  const wanted = cleanMentionIds(mentionIds, actorId);
  if (wanted.length) {
    const rows = await db.all('SELECT id, name FROM users WHERE id = ANY($1::int[])', [wanted]);
    const byId = new Map(rows.map(r => [Number(r.id), r.name]));
    tagged = wanted.filter(id => byId.has(id)).map(id => ({ id, name: byId.get(id) }));
  }

  const suffix = viaSuffix(via);
  const text = suffix ? (typed ? typed + suffix : suffix.trim()) : typed;

  // Message, attachments, mentions and the open → in_progress move land
  // together or not at all.
  const saved = await db.withTransaction(async (client) => {
    const q = (await client.query(
      'SELECT id, query_no, status FROM customer_queries WHERE id=$1 FOR KEY SHARE', [qid])).rows[0];
    if (!q) return null;
    const m = await client.query(
      'INSERT INTO customer_query_messages (query_id, user_id, message) VALUES ($1,$2,$3) RETURNING id',
      [q.id, actorId, text]);
    const messageId = m.rows[0].id;
    for (const f of files) {
      await client.query(
        'INSERT INTO customer_query_message_attachments (message_id, file_path, file_name, file_size, mime_type) VALUES ($1,$2,$3,$4,$5)',
        [messageId, f.file_path, f.file_name, f.file_size, f.mime_type]);
    }
    for (const t of tagged) {
      await client.query(
        'INSERT INTO customer_query_mentions (message_id, query_id, mentioned_user_id) VALUES ($1,$2,$3)',
        [messageId, q.id, t.id]);
    }
    // Mark query as in_progress if it was open
    const moved = await client.query(
      "UPDATE customer_queries SET status='in_progress', updated_at=NOW() WHERE id=$1 AND status='open' RETURNING id",
      [q.id]);
    return { q, messageId, movedToInProgress: moved.rowCount > 0 };
  });
  if (!saved) return notFound;
  const { q, messageId } = saved;

  // Alert everyone tagged. The message is already saved, so a failed alert is
  // logged rather than reported as a failed post.
  const preview = text.slice(0, 100);
  const fileNote = files.length ? ` [+${files.length} file${files.length > 1 ? 's' : ''}]` : '';
  for (const t of tagged) {
    try {
      await createNotification(db, {
        userId: t.id,
        type: 'query_message',
        title: `${senderName} in ${q.query_no}`,
        body: preview ? preview + fileNote : `Sent${fileNote}`,
        link: `/customer-queries/${q.id}`,
        sourceUserId: actorId,
        ref: { type: 'query_thread', id: q.id },
      });
    } catch (e) {
      console.error(`Customer query ${q.query_no}: mention alert to user ${t.id} failed:`, e.message);
    }
  }

  const fileWord = `${files.length} file${files.length > 1 ? 's' : ''}`;
  const what = !typed ? fileWord : (files.length ? `a message with ${fileWord}` : 'a message');
  const tagNote = tagged.length ? ` and tagged ${tagged.map(t => t.name).join(', ')}` : '';
  const summary = `Posted ${what} in customer query ${q.query_no}${tagNote}`;

  return {
    ok: true,
    summary,
    data: {
      id: messageId,
      queryId: q.id,
      queryNo: q.query_no,
      message: text,
      mentioned: tagged.map(t => t.id),
      attachments: files.length,
      movedToInProgress: saved.movedToInProgress,
    },
  };
}

module.exports = { postQueryMessage, cleanMentionIds };
