// Application-tailored outreach copy for the Prospecting module.
//
// Each block feeds a shared template, so the subject line, opening hook, the three
// spec bullets and the follow-up angle all change with the prospect's application.
// Keyed by the `application` value stored on each prospect row.

export const APP_COPY = {
  "Autoclaves & sterilizers": {
    product: "flanged & screw-plug immersion heaters (SS316 / Incoloy 800 sheath)",
    subjectIntro: "SS316 immersion heaters for {{company}} autoclaves",
    subjectFollow: "Where autoclave elements actually fail",
    hook: "Autoclave elements fail at the sheath-to-flange transition, not in the resistance wire. Repeated 121\u00b0C and 134\u00b0C cycles, plus condensate sitting on the cold end, drive pitting and then earth leakage. We build flanged and screw-plug immersion heaters for chambers and jacket boilers in SS316 or Incoloy 800, with a sealed cold end and a hi-pot and insulation-resistance record on every unit.",
    bullets: ["SS316 or Incoloy 800 sheath, 8.0 or 8.5 mm OD, chloride-tolerant", "Screw-plug 1\" to 1.5\" BSP, or flanged 2\"-4\" drilled to your PCD", "20-25 W/cm\u00b2 in steam duty to stop dry-spot burnout at the top bend"],
    followHook: "We can build one element to your existing autoclave drawing at no cost, so your team can bench it against the incumbent. Flange PCD, immersed length, kW and terminal layout copied exactly. Sheath material certificates come with it if your QA file needs them.",
  },
  "Fluid bed dryers & granulation": {
    product: "finned tubular air heaters",
    subjectIntro: "Finned air heaters for {{company}} FBD inlet banks",
    subjectFollow: "What watt density is your FBD bank running at?",
    hook: "The common complaint on FBD inlet banks is scorch: localised over-temperature in the plenum and discoloured product in the bowl. That is nearly always watt density, not a shortage of kW. We build finned tubular air heaters with helically wound fins that carry the same duty at a far lower sheath temperature, with fin pitch set to your actual CFM and inlet delta-T.",
    bullets: ["2.5-3.5 W/cm\u00b2 sheath loading, well under product scorch temperature", "SS304 or Incoloy 800 sheath, wound SS fins at 3-4 fins per inch", "Hairpin or trombone banks to your plenum frame, no ducting rework"],
    followHook: "Send the nameplate kW, duct cross-section and airflow for one bank and we will work out the watt density your current element runs at. That single number explains most scorching problems. We can supply one element for trial before you change out a whole bank.",
  },
  "Tablet coating & drying": {
    product: "finned tubular air heaters for coating AHUs, plus flanged immersion heaters for hot-water-fed pans",
    subjectIntro: "Coating pan inlet heaters for {{company}}",
    subjectFollow: "Holding a spare element for your coating suite",
    hook: "Coating pans run to a drying curve, so inlet air stability decides coat quality. One failed leg in the bank mid-batch pushes you into twinning and surface defects. We build finned tubular air heaters for coating AHUs split across independent circuits, so a single failure degrades output instead of stopping the batch, and we keep sheath temperature deliberately low on solvent suites.",
    bullets: ["Two or three independent circuits per bank, so one failure never stops a batch", "Reduced watt density for solvent suites, thermocouple pocket set for PID control", "SS304 finned tubulars, furnace-annealed and CNC-bent to your AHU frame"],
    followHook: "Most coating lines are better off with one or two elements on the shelf than waiting mid-campaign. We can quote your exact element as a stocked spare and hold the drawing on file for repeats. A photo of the terminal end is usually enough if no drawing exists.",
  },
  "Stability chambers & incubators": {
    product: "finned tubular air heaters (SS304 / SS316 sheath, low watt density)",
    subjectIntro: "Duct heaters for {{company}} stability chambers",
    subjectFollow: "Like-for-like swap on your chamber element",
    hook: "ICH conditions mean holding \u00b10.5\u00b0C across the working volume while the humidity system pulls the other way. Most chamber heater trouble we see is watt density set too high for a low-velocity recirculating duct, so the outlet runs hot and the RH loop hunts. We build finned tubular air heaters at 2-3 W/cm\u00b2 specifically for that duct work.",
    bullets: ["2-3 W/cm\u00b2 so duct air is not scorched and RH control stays steady", "SS304 or SS316 sheath, spiral fins pitched to your duct velocity", "Megger, cold resistance and earth continuity recorded on every element"],
    followHook: "We can build one element to your current chamber drawing and send it over, so your team can run a uniformity map against the incumbent before committing. A photo of the terminal end works if the drawing is not to hand. We will quote a like-for-like swap with landed cost alongside.",
  },
  "Ovens & furnaces": {
    product: "Incoloy 800 tubular oven elements and wound coil & muffle furnace elements",
    subjectIntro: "Oven and muffle elements to {{company}} drawings",
    subjectFollow: "Incoloy vs SS316 \u2014 where you can drop a grade",
    hook: "Oven elements fail at the ends, not the middle. Moisture and thermal cycling work on the terminal seal until it lets go. In muffle work the usual culprit is grain growth in the coil after a few hundred cycles. We cover both sides: Incoloy 800 sheathed tubular elements for hot-air ovens, and wound coil elements formed to your chamber geometry, dispatched in 5-7 days.",
    bullets: ["Incoloy 800 above 550\u00b0C sheath, SS304 or SS316 below, sized to your air velocity", "Furnace-annealed tube, CNC bent to hairpin, W-form or multi-pass", "Coils wound to your resistance spec and chamber pitch, priced for repeat runs"],
    followHook: "Worth checking one thing on your current spec: many oven builders carry Incoloy across the whole range when SS316 is fine below 550\u00b0C sheath. On volume that is real money per element. Send us the set point and duty cycle and we will price both grades honestly.",
  },
  "Dissolution & water baths": {
    product: "water-bath immersion elements and screw-plug immersion heaters (SS316)",
    subjectIntro: "Bath elements for {{company}} dissolution units",
    subjectFollow: "A screw-plug swap gets a bath back same day",
    hook: "A dissolution bath holds 37\u00b0C for hours at low duty, so the sheath sits in media that leaves a scale film. Once that film builds, surface temperature climbs and the element opens at the water line. We build water-bath immersion elements in SS316 at 6-8 W/cm\u00b2, formed to sit clear of the vessel base and the stirrer path.",
    bullets: ["SS316 sheath at 6-8 W/cm\u00b2, slow to scale in treated bath water", "Screw-plug 1\" to 1.5\" BSP, or flanged, built to your tank drawing", "Moisture-sealed terminal ends, dielectric test recorded on every unit"],
    followHook: "If your baths use a welded-in element, a screw-plug version pays for itself the first time one fails: the bath is back in service the same day instead of going out for welding. Send tank dimensions and current wattage and we will draw a drop-in alternative. Starting with one bath is fine.",
  },
  "Aircraft manufacturing": {
    product: "finned tubular air heaters (Incoloy 800) and flanged immersion heaters (SS316)",
    subjectIntro: "Cure oven and tank line elements for {{company}}",
    subjectFollow: "First article and material certs on cure oven elements",
    hook: "A 175\u00b0C composite cure held to \u00b15\u00b0C across the part needs even fin pitch and low watt density, not a bank with hot spots near the duct wall. The degreasing and conversion-coating tanks on the same floor need immersion heaters that tolerate scale without dry-firing. We build both to drawing in SS304, SS316 and Incoloy 800, with sheath material certification on request.",
    bullets: ["2.0-3.5 W/cm\u00b2 finned air heaters, Incoloy 800 sheath rated to 750\u00b0C", "Flanged immersion heaters in SS316, low density for alkaline conversion baths", "Dimensional check, hi-pot and insulation-resistance record per element"],
    followHook: "We can run a first article against your element drawing and send it with the dimensional report and sheath certificate before any batch is released. Most aerospace shops we supply began by replacing one failed bank rather than the whole set. Drawing sign-off to dispatch is about two weeks on a first part.",
  },
  "Aircraft & engine MRO": {
    product: "flanged and screw-plug immersion heaters (SS316 / Incoloy 800), plus finned tubular air heaters for drying cabinets",
    subjectIntro: "Tank heaters for {{company}} strip and clean lines",
    subjectFollow: "Liquid line or cold end? Reading a failed heater",
    hook: "MRO shops go through tank heaters faster than most. Paint-strip baths, hot alkaline carbon-removal and phosphate lines cycle hot and cold every day, and the wrong sheath alloy pits at the liquid line inside months. Sludge settling over the lower element does the rest. We build flanged and screw-plug immersion heaters in SS316 and Incoloy 800 for exactly that duty.",
    bullets: ["Incoloy 800 screw-plugs, 1\" to 2\" BSP or NPT, bends set above the sludge line", "Under 3 W/cm\u00b2 for phosphate and solvent baths, so film temperature stays low", "Finned tubular air heaters for post-wash and NDT part-drying cabinets"],
    followHook: "On your worst tank, check whether failures sit at the liquid line or at the cold end. One points to alloy choice, the other to moisture at the terminal, and the fixes are different. Send a photo of a failed element and I will tell you which it is, then quote against your existing part number.",
  },
  "UAV & composites": {
    product: "custom-formed tubular elements, pitot-tube and de-icing heaters, and finned tubular air heaters for cure ovens",
    subjectIntro: "Pitot and de-icing elements for {{company}}",
    subjectFollow: "One prototype element before you commit to a batch",
    hook: "UAV programmes carry two heat problems that rarely sit with the same engineer. Airframe side, pitot probes and leading edges need small-diameter formed elements with tight bend radii and low mass. Shop side, out-of-autoclave ovens and hot-bonder work need uniform heat for a 120-180\u00b0C cure without overshooting a thin skin. We make custom-formed tubular elements and finned air heaters for both.",
    bullets: ["Small-diameter CNC-formed elements for pitot and probe de-icing, SS316 sheath", "De-icing elements built to a stated resistance, cold zones outside the heated area", "Low minimums on development builds, bulk capacity once the programme scales"],
    followHook: "At prototype stage we will make a single element to your drawing before you commit to a batch. It costs a drawing and about a week. Send a sketch with the resistance and cold-zone requirement and we will quote it, and put the delivered cost next to your current supply.",
  },
  "Heating elements & distribution": {
    product: "tubular heating elements to drawing (SS304 / SS316 / Incoloy 800), plus cartridge, band and finned tubular lines",
    subjectIntro: "Element manufacturing to drawing for {{company}}",
    subjectFollow: "We will build your fastest-moving part number",
    hook: "Distributors get squeezed on the odd sizes: the 1,200 mm U-form in Incoloy, the 8 mm straight rod, the customer who wants forty pieces to a drawing rather than four thousand. Most makers only quote their own catalogue lengths, so you either carry dead stock or lose the order. We manufacture to submitted drawings in 6.5, 8 and 8.5 mm tube, so you quote your customer's part number.",
    bullets: ["SS304, SS316 and Incoloy 800 offered against the same part number", "U, W, hairpin, helical and multi-plane forms, cold zones and leads per line", "5-7 day dispatch ex-Ahmedabad, 6-month guarantee passing to your customer"],
    followHook: "Easiest way to judge us is on your own part. Send a drawing or a sample of a fast mover and we will build one for you to strip down against your current supply. We will price it landed, so it sits straight against your existing cost sheet.",
  },
  "Boilers & steam": {
    product: "flanged and screw-plug immersion heater bundles, plus water-bath immersion elements for small vessels",
    subjectIntro: "Immersion bundles for {{company}} steam vessels",
    subjectFollow: "More elements, lower density, longer life on hard water",
    hook: "Electric steam generators fail in two places: the sheath under scale at the waterline, and the terminal box when condensate tracks down the leads. Both are decided at the element, not the panel. We build flanged and screw-plug immersion bundles sized to keep sheath temperature under the scaling threshold for your actual feedwater, with the terminal end sealed against steam ingress.",
    bullets: ["25-30 W/sq.in on untreated feedwater, up to 45 W/sq.in on treated", "Incoloy 800 for high-mineral feedwater, SS316 for treated and condensate service", "Thermowell pocket inside the bundle for control and high-limit sensors"],
    followHook: "If replacement cycles are the real cost, a spec change beats a price cut. The same kW spread across more elements at lower density typically doubles time to failure on hard feedwater for a small increase in heater cost. Send a failed element or your current drawing and we will come back with a redesigned bundle and a landed price.",
  },
  "Furnaces & kilns": {
    product: "coil and muffle furnace elements, plus custom-formed spring/coil elements",
    subjectIntro: "Coil and muffle windings for {{company}} furnaces",
    subjectFollow: "Matched zone sets against your annual usage",
    hook: "Muffle and chamber elements rarely fail from age. They fail from pitch drift. Once a coil sags into itself the shorted turns run hot, resistance drops, and chamber uniformity goes long before the element opens. We wind coil and muffle elements to a specified mandrel diameter and stretched pitch, so the coil sits correctly in the groove or on the support tube from day one.",
    bullets: ["Wound to your mandrel diameter, wire gauge and stretched length, on design ohms cold", "Formed for brick-groove, support-tube or free-hanging mounting, tails to your bushing", "Matched sets so every zone in the furnace ages together"],
    followHook: "Send a used coil or the drawing and we will wind one to that spec, so you can check cold resistance and groove fit before ordering a set. Landed cost from Ahmedabad sits well under European supply on repeat furnace sets. We can also hold matched zone sets against your annual usage.",
  },
  "Geysers & water heaters": {
    product: "screw-plug immersion heaters and formed tubular water immersion elements",
    subjectIntro: "Tank elements for {{company}} water heaters",
    subjectFollow: "Annual volume pricing on your geyser element",
    hook: "Most geyser element failures are scale driven. High surface watt density bakes hardness salts into an insulating crust, the core runs hot, and the element opens inside warranty. We build tubular water immersion elements for water heater OEMs at derated density in SS316 or Incoloy 800, CNC-formed to your tank geometry rather than a stock U-bend.",
    bullets: ["8-10 W/cm\u00b2 surface density in SS316 or Incoloy 800 for high-TDS supply", "1\", 1.25\" or 1.5\" BSP brass or SS boss, thermostat pocket to your position", "Furnace-annealed tube so bends do not work-harden or crack at the neck"],
    followHook: "On volume this is mostly a cost conversation. A like-for-like swap at lower watt density usually lands at the same piece price and moves your warranty return rate more than any material change. Send your annual quantity and current drawing and we will price a full year, with 5-7 day dispatch per batch.",
  },
  "Catering & bakery ovens": {
    product: "tubular deck and cavity oven elements, plus bain-marie and fryer elements",
    subjectIntro: "Deck and cavity elements for {{company}} ovens",
    subjectFollow: "Spares that still fit machines built years ago",
    hook: "Uneven bake in a deck oven is usually element layout rather than the controller. A serpentine that does not cover the deck footprint leaves cold corners and a dark band under the tightest bend. We form tubular oven elements to the exact deck plan, keep cold ends outside the chamber, and do the same for bain-marie and fryer elements where the heated section must sit below minimum liquid level.",
    bullets: ["SS304 or Incoloy 800 sheath for radiant deck and convection duty", "Heated length and pitch set to your deck footprint, cold ends defined", "Fryer and bain-marie elements with dry-run margin built into the density"],
    followHook: "Spares are where kitchen equipment gets awkward. An element 5 mm off on bend centres will not drop into a machine already in the field. We keep your drawing and fixture, so repeats come back dimensionally identical years later, and we can quote the production run and a spares kit off the same tooling.",
  },
  "Electroplating & finishing": {
    product: "flanged and over-the-side immersion heaters for process tanks",
    subjectIntro: "Tank heaters for {{company}} plating lines",
    subjectFollow: "Sheath and density, tank by tank on your line",
    hook: "Process tanks punish the wrong watt density long before they punish the wrong alloy. In an alkaline soak cleaner a high-density element boils solution at the sheath, drops salts onto the surface and carbonises brightener additives, and the element goes open under the crust. We build flanged and over-the-side immersion heaters at low surface density, formed to clear anode bars and work travel.",
    bullets: ["3-5 W/cm\u00b2 for alkaline degreasing, phosphating and hot rinse tanks", "SS316 or Incoloy 800 chosen against your bath chemistry and temperature", "Over-the-side L-form or flanged, thermowell so the controller reads solution"],
    followHook: "Send the chemistry, concentration and working temperature for each tank and we will come back with sheath and watt density tank by tank, including any tank where we would tell you not to use our element. Where things are failing now, a photo of the sheath is the fastest read: the scale pattern shows which tank runs too hot.",
  },
  "Industrial & curing ovens": {
    product: "finned tubular air heaters (SS304 / Incoloy 800, hairpin and W-form)",
    subjectIntro: "Finned elements for {{company}} oven builds",
    subjectFollow: "Set pricing on your repeat oven models",
    hook: "Above roughly 3.5 W/cm\u00b2 a finned element starts oxidising at the fin roots, the fins load with cured overspray, and a zone that used to hold \u00b15\u00b0C begins to drift. We size finned tubular air heaters to your duct dimension and design CFM so the sheath sits well under its limit. Elements are bent to your plenum drawing, so a hairpin or W-form drops into the existing frame.",
    bullets: ["2.0-3.0 W/cm\u00b2 for recirculating air, so fin roots do not oxidise", "SS304 to around 550\u00b0C, Incoloy 800 for 750\u00b0C post-bake duty", "CNC bent to your plenum drawing, no frame or duct modification"],
    followHook: "On repeat oven models the numbers work best in volume. Send the element schedule for a model you build regularly and we will price the set rather than the piece. We can build one sample to your drawing first if you want it benched, and dispatch runs 5-7 days once a drawing is approved.",
  },
  "Plastics machinery": {
    product: "mica and ceramic band heaters, plus cartridge heaters for nozzle and hot-runner zones",
    subjectIntro: "Band and cartridge heaters for {{company}} barrels",
    subjectFollow: "Ceramic knuckle vs mica on your hottest zone",
    hook: "On injection and extrusion barrels the failure is mechanical before it is electrical. A band that has lost clamping contact air-gaps, the sheath overshoots, and it burns out while the melt zone still reads cold. We make mica and ceramic band heaters clamped to your measured barrel OD, with cut-outs and lead exits where the machine needs them, plus cartridge heaters for nozzle and hot-runner bores.",
    bullets: ["Mica bands to 400\u00b0C, ceramic knuckle type to 700\u00b0C for filled polymers", "Swaged cartridge heaters with distributed density, so blind-hole tips run cool", "Wattage and voltage split zone by zone to your machine schedule"],
    followHook: "Send the barrel OD, width and zone wattages for one machine and we will quote the full set, or ship a single band or nozzle cartridge for trial first. On glass-filled compounds a ceramic knuckle band usually pays back in element life on the hottest zone. Repeat volumes land well under European pricing.",
  },
  "Incubators & lab ovens": {
    product: "low watt density finned tubular air heaters and SS316 tubular elements",
    subjectIntro: "Low density elements for {{company}} incubators",
    subjectFollow: "SS304 and SS316 priced side by side",
    hook: "Incubators are the reverse of industrial heating. The job is holding 37\u00b0C or 60\u00b0C to a fraction of a degree with no hot wall and no radiant streaking on the top shelf, often with very little air movement. That needs low watt density, under about 1.5 W/cm\u00b2, and enough finned surface to move heat gently. We build finned and plain tubular elements to that brief in SS304 or SS316.",
    bullets: ["0.8-1.5 W/cm\u00b2 so chamber air heats without shelf-level gradients", "SS316 for humidified chambers and routine disinfectant wipe-down", "Tight-radius bends on annealed tube for shallow rear plenums and side ducts"],
    followHook: "We will build two elements to your chamber drawing so you can map uniformity against your current supply before ordering. We will quote SS304 and SS316 side by side, so the cost of the sheath upgrade on humidified units is clear. Every element is tested before it ships and carries the 6-month guarantee.",
  },
};

// Used when no single application is in view (e.g. "All applications" selected).
export const GENERIC_COPY = {
  product: 'custom tubular heating elements',
  subjectIntro: 'Heating elements built to your drawing — Peena Heat Elements',
  subjectFollow: 'Following up on element supply for {{company}}',
  hook: "I'm getting in touch because {{company}} builds equipment that runs on heating elements, and that is the only thing we make. We manufacture tubular elements to drawing in SS304, SS316 and Incoloy 800 — CNC bent, furnace annealed and tested before they leave the floor.",
  bullets: [
    'SS304, SS316 or Incoloy 800 sheath, formed to your exact drawing',
    'Every element hi-pot and insulation-resistance tested before dispatch',
    '5-7 day dispatch from Ahmedabad, priced for repeat volume',
  ],
  followHook: 'If you share a drawing or the current element spec — sheath material, watt density and dimensions — we will come back with a quote and can build one sample for your team to bench against the incumbent.',
};

export function copyFor(application) {
  return (application && APP_COPY[application]) || GENERIC_COPY;
}

const SIGNOFF = [
  'Warm regards,',
  'Vama',
  'Peena Heat Elements LLP, Ahmedabad',
  'vama@peenaheatelements.com',
].join('\n');

/**
 * Build the tailored email for an application.
 * `which` is 'intro' | 'follow'. {{company}} is left in place for Zoho to merge.
 */
export function renderEmail(which, application) {
  const c = copyFor(application);
  if (which === 'follow') {
    return {
      subject: c.subjectFollow,
      body: [
        'Dear [Procurement Team],',
        '',
        `A short follow-up on my note about ${c.product}.`,
        '',
        c.followHook,
        '',
        'If you can share a drawing or the current spec — sheath material, watt density and dimensions — we will quote it and build one sample for your team to test.',
        '',
        'No pressure either way. Happy to just answer questions.',
        '',
        SIGNOFF,
      ].join('\n'),
    };
  }
  return {
    subject: c.subjectIntro,
    body: [
      'Dear [Procurement Team],',
      '',
      "I'm Vama from Peena Heat Elements (PHE), a tubular heating element manufacturer in Ahmedabad, India.",
      '',
      c.hook,
      '',
      ...c.bullets.map(b => `\u2192 ${b}`),
      '',
      'Every element is tested before it leaves our floor and carries a 6-month guarantee. We dispatch in 5-7 days and already supply OEMs across India and on export.',
      '',
      `I would be glad to build one ${c.product.split('(')[0].trim()} to your drawing so your team can bench it against the incumbent — no obligation.`,
      '',
      'Would a short call this week suit you?',
      '',
      SIGNOFF,
    ].join('\n'),
  };
}
