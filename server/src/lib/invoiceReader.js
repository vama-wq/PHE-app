const Anthropic = require('@anthropic-ai/sdk');

// Reads a supplier's invoice (photo or PDF) when an item is received, so the
// PO can follow the BILL: invoice number and date, each line's billed quantity
// and rate, packaging & forwarding and the GST rate. Accounts checks the
// figures on screen before saving — nothing here is written to the database.
// Owner's rule (2 Oct 2026): payment follows the bill; stock follows what QC
// counts.

let _client = null;
function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}

const MODEL = 'claude-opus-5-5';
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const MAX_BYTES = 4.8 * 1024 * 1024;   // the API's per-image limit is 5 MB

const TOOL = {
  name: 'invoice_figures',
  description: 'The figures printed on this supplier invoice, matched to the purchase-order lines given.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      readable: { type: 'boolean', description: 'false when the document is not a supplier invoice or is too unclear to read figures from' },
      invoice_no: { type: ['string', 'null'] },
      invoice_date: { type: ['string', 'null'], description: 'YYYY-MM-DD' },
      gst_percent: { type: ['number', 'null'], description: 'Total GST rate on the goods: IGST %, or CGST % + SGST % added together' },
      packaging_forwarding: { type: ['number', 'null'], description: 'Packing / forwarding / freight / courier charged ON THIS INVOICE as a separate line, before GST. null when there is none' },
      lines: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            po_item_id: { type: 'integer', description: 'the PO line this invoice line is for' },
            description_on_invoice: { type: 'string' },
            billed_qty: { type: ['number', 'null'] },
            unit_on_invoice: { type: ['string', 'null'] },
            rate: { type: ['number', 'null'], description: 'price per unit before GST' },
            amount: { type: ['number', 'null'], description: 'line amount before GST' },
          },
          required: ['po_item_id', 'description_on_invoice', 'billed_qty', 'unit_on_invoice', 'rate', 'amount'],
        },
      },
      confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
      notes: { type: 'string', description: 'anything the person checking should look at: an unclear digit, a line that matched no PO line, a unit that differs from the PO' },
    },
    required: ['readable', 'invoice_no', 'invoice_date', 'gst_percent', 'packaging_forwarding', 'lines', 'confidence', 'notes'],
  },
};

const PROMPT = (po, lines) => `This is a supplier's tax invoice received with a delivery against our purchase order ${po.po_number} (supplier on our PO: ${po.supplier_name || 'unknown'}).

Our PO lines, with the id to use for po_item_id:
${lines.map(l => `  id ${l.id}: "${l.description}" — ordered ${l.qty} ${l.unit || ''} @ ₹${l.rate}`).join('\n')}

Read the figures EXACTLY as printed. Match each invoice line to the PO line it is for (by description, size and unit); leave out invoice lines that are for none of them and mention them in notes. A quantity, rate or number that is not clearly legible is null, never a guess. Rate and amount are before GST. If the invoice is in another unit from the PO line (kg against pieces or feet, or the other way round), give the invoice figures as printed, give the invoice's unit in unit_on_invoice, and say so in notes. Our own GSTIN 24ABGFP7267B1ZA is the buyer's — ignore it. Call invoice_figures once.`;

async function readInvoice({ buffer, mimetype, po, lines }) {
  const client = getClient();
  if (!client) return { readable: false, notes: 'Invoice reading is not set up on the server (no API key).' };
  const type = String(mimetype || '').toLowerCase();
  if (type !== 'application/pdf' && !IMAGE_TYPES.includes(type)) {
    return { readable: false, notes: `Cannot read a ${type || 'file of this type'} — use a JPG, PNG or PDF, or type the figures from the bill.` };
  }
  if (buffer.length > MAX_BYTES && type !== 'application/pdf') {
    return { readable: false, notes: 'The photo is too large to read — take a smaller one, or type the figures from the bill.' };
  }
  const data = buffer.toString('base64');
  const doc = type === 'application/pdf'
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }
    : { type: 'image', source: { type: 'base64', media_type: type, data } };

  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: 8000,
    tools: [TOOL],
    // (this model does not take a forced tool_choice — the prompt asks for the
    // single call, and a reply without one is treated as unreadable)
    messages: [{ role: 'user', content: [doc, { type: 'text', text: PROMPT(po, lines) }] }],
  });
  const call = (resp.content || []).find(c => c.type === 'tool_use' && c.name === 'invoice_figures');
  if (!call) return { readable: false, notes: 'The invoice could not be read — type the figures from the bill.' };
  const out = call.input;
  const ids = new Set(lines.map(l => l.id));
  out.lines = (out.lines || []).filter(l => ids.has(Number(l.po_item_id)));
  return out;
}

module.exports = { readInvoice, MODEL };
