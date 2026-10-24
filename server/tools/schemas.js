import { seed } from '../seed.js';

// The tool contract between the Bedrock agent and the Tool_Layer.
// Every tool takes a `reason`; it is written to the Decision_Log for the coordinator.

const ITEMS = Object.keys(seed.catalog);
const itemHelp = Object.entries(seed.catalog)
  .map(([k, v]) => `${k} (${v.type})`)
  .join(', ');

const reason = {
  type: 'string',
  description: 'One short sentence on why you are doing this. Shown to the coordinator. No names or addresses.',
};
const urgency = {
  type: 'string',
  enum: ['critical', 'urgent', 'routine'],
  description: 'critical: risk to life or health within hours (e.g. refrigerated insulin warming, powered medical device failing). urgent: needed today. routine: can wait and may be batched with other deliveries.',
};

const spec = (name, description, properties, required) => ({
  toolSpec: { name, description, inputSchema: { json: { type: 'object', properties, required, additionalProperties: false } } },
});

export const RESOURCE_TYPES = ['medicine', 'food', 'water', 'shelter', 'power', 'info'];
export const ITEM_KEYS = ITEMS;

export const toolSpecs = [
  spec(
    'classify_need',
    'Record your triage of the caller\'s need. Call this FIRST for each new need. Use resource_type "unclear" only if you cannot tell what they need (the system limits you to 2 clarifying questions, then falls back to "info").',
    {
      resource_type: { type: 'string', enum: [...RESOURCE_TYPES, 'unclear'] },
      item: { type: 'string', description: `Specific item if known. One of: ${itemHelp}.` },
      urgency,
      needs_delivery: { type: 'boolean', description: 'true if the caller cannot travel to the site themselves (no car, mobility limits).' },
      summary: { type: 'string', description: 'Max 20 words. No names, addresses or phone numbers.' },
      reason,
    },
    ['resource_type', 'urgency', 'reason'],
  ),
  spec(
    'find_resource',
    'Find nearby OPEN sites that have the item in stock (nearest first, at most 5), or for resource_type "info" return verified bulletins. This is the ONLY source of site names, hours and stock.',
    {
      resource_type: { type: 'string', enum: RESOURCE_TYPES },
      item: { type: 'string', description: `Item key or a plain name. Known items: ${itemHelp}. Required for medicine.` },
      topic: { type: 'string', description: 'For info requests: the topic, e.g. "power restoration", "cooling center hours", "road closures".' },
      reason,
    },
    ['resource_type', 'reason'],
  ),
  spec(
    'check_shortage',
    'Check the live openFDA national drug-shortage listing for a medicine. National status only, NOT local stock. "Not listed" does not mean a pharmacy has it.',
    { drug_name: { type: 'string', description: 'Generic or brand name, e.g. "insulin glargine".' }, reason },
    ['drug_name', 'reason'],
  ),
  spec(
    'normalize_drug',
    'Convert a brand or spoken drug name into its generic name using RxNorm. Use before check_shortage when the name is a brand name or unclear.',
    { spoken_name: { type: 'string' }, reason },
    ['spoken_name', 'reason'],
  ),
  spec(
    'reserve',
    'Place a hold on an item at a site. Only call after the caller agreed to the site. Medicine holds may need coordinator approval; if the result status is "pending_approval", tell the caller you are waiting for the coordinator and do NOT retry.',
    {
      site_id: { type: 'string', description: 'site_id from find_resource.' },
      item: { type: 'string', enum: ITEMS },
      quantity: { type: 'integer', minimum: 1, maximum: 5 },
      reason,
    },
    ['site_id', 'item', 'reason'],
  ),
  spec(
    'dispatch_volunteer',
    'Assign a volunteer driver to deliver a held item to the caller. Needs an active hold_id. If a re-plan is in progress this re-routes the same driver to the new site.',
    { hold_id: { type: 'string' }, urgency, reason },
    ['hold_id', 'urgency', 'reason'],
  ),
  spec(
    'escalate',
    'Alert coordinator Rosa. Use severity "emergency" for any medical red flag (chest pain, trouble breathing, confusion, unconscious, stroke signs) and then tell the caller to call 911. Use "coordinator" when you need a human (no site, no driver, caller upset, anything you cannot safely handle).',
    {
      severity: { type: 'string', enum: ['emergency', 'coordinator'] },
      red_flag: { type: 'string', enum: ['chest_pain', 'difficulty_breathing', 'confusion', 'other', 'none'] },
      reason,
    },
    ['severity', 'reason'],
  ),
  spec(
    'request_address_consent',
    'Call this BEFORE asking for or storing the caller\'s address. It starts the consent step. Then ask the caller out loud: "May I save your address so the driver can find you? Please say yes or no." Do not call save_address until the system reports consent was granted.',
    { reason },
    ['reason'],
  ),
  spec(
    'save_address',
    'Store the caller\'s delivery address. Fails unless the caller verbally consented after request_address_consent.',
    { address: { type: 'string', description: 'Street address as spoken by the caller.' }, reason },
    ['address', 'reason'],
  ),
];
