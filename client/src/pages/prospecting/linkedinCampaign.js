// LinkedIn calendar (owner, 26 Oct 2026): one post every Wednesday 10:30 am, 28 Oct – 30 Dec 2026, plus Diwali.
// Files live in client/public/linkedin (videos re-encoded smaller for download); captions match
// phe-claude-code/output/linkedin-oct-dec-2026/captions.txt. Add a post here when a new one is planned.
const WA = 'WhatsApp: +91 84520 55836';
const KK_LINK = 'https://khadhyakhurak.com/registration/peena_heat_elements_llp';

export const LINKEDIN_POSTS = [
  { key: 'w01', date: '2026-10-28', kind: 'video', topic: 'Hello from PHE', file: '/linkedin/w01.mp4', poster: '/linkedin/w01.jpg', dur: '0:23',
    how: 'Video: upload the file as it is. The full range, then spiral, hairpin, U-bend, formed and immersion elements, then the logo card.',
    caption: `Heat, made to your drawing. 🔥

We're Peena Heat Elements, Ahmedabad: tubular, finned, immersion and cartridge heating elements for the machines you build.

Every Wednesday we'll share what we make and how we make it. Follow along.

${WA}
#HeatingElements #Manufacturing #MadeInIndia #Ahmedabad` },
  { key: 'w02', date: '2026-11-04', kind: 'flyer', topic: 'Food & kitchen machines', file: '/linkedin/w02.pdf', poster: '/phe-khadya-khurak-flyer.jpg',
    how: 'Document: Add a document → upload the PDF, title “Heating elements for food & kitchen machines”.',
    caption: `Building ovens, fryers, bain-maries or roti machines?

→ U-bends, spirals, formed elements and cast hotplates
→ SS304 · SS316 · Incoloy 800
→ Made to your drawing, tested before dispatch

Send a drawing, or a photo of your element beside a measuring tape.
${WA}
#FoodMachinery #CommercialKitchen #FoodProcessing #HeatingElements` },
  { key: 'diwali', date: '2026-11-08', kind: 'greeting', topic: 'Diwali greeting', file: '/linkedin/diwali.jpg', poster: '/linkedin/diwali.jpg',
    how: 'Image: post the card on Diwali morning (a Sunday).',
    caption: `Happy Diwali from all of us at Peena Heat Elements. 🪔

Thank you to our customers, suppliers and our team for a bright year. Wishing you light, health and prosperity. Shubh Deepavali! शुभ दीपावली 🪔

#HappyDiwali #ShubhDeepavali` },
  { key: 'w03', date: '2026-11-11', kind: 'video', topic: 'The full range', file: '/linkedin/w03.mp4', poster: '/linkedin/w03.jpg', dur: '0:17',
    how: 'Video: upload the file as it is (the still photo is at /linkedin/w03-photo.jpg if you prefer an image).',
    caption: `One partner, every shape.

Straight, U-bend, formed, spiral and cast-in elements, plus screw-plug and flanged immersion heaters, all made here in Ahmedabad.

Which one goes in your machine? Tell us.
${WA}
#HeatingElements #OEM #MakeInIndia #Ahmedabad` },
  { key: 'w04', date: '2026-11-18', kind: 'video', topic: 'New: 2-in-1 & 3-in-1 heaters', file: '/linkedin/w04.mp4', poster: '/linkedin/w04.jpg', dur: '0:17',
    how: 'Video: upload the file as it is (the flyer PDF is at /linkedin/w04-flyer.pdf for the customer email).',
    caption: `New at PHE: 2-in-1 and 3-in-1 heaters, now supplied fully fitted.

→ Thermostat pocket, cap & sleeve, gasket and thermostat: ready to fit
→ Heater plates too: round, oval & square, 4-hole dishwasher flanges
→ Made to your drawing

Want them on your next order?
${WA}
#NewProduct #HeatingElements #MadeInIndia` },
  { key: 'w05', date: '2026-11-25', kind: 'video', topic: 'Made to your drawing', file: '/linkedin/w05.mp4', poster: '/linkedin/w05.jpg', dur: '0:17',
    how: 'Video: upload the file as it is.',
    caption: `Most of our elements start as a drawing. Some start as a sketch on paper.

We draw it up, make a sample and, once you're happy, the batch.
SS304 · SS316 · Incoloy 800.

Send us yours.
${WA}
#CustomManufacturing #Engineering #HeatingElements` },
  { key: 'w06', date: '2026-12-02', kind: 'flyer', topic: 'Pharma equipment', file: '/linkedin/w06.pdf', poster: '/phe-pharmatech-khadya-flyer.jpg',
    how: 'Document: Add a document → upload the PDF, title “Heating elements for pharma equipment”.',
    caption: `Building autoclaves, sterilizers, dryers or stability chambers?

→ Flanged & screw-plug immersion heaters in SS316 / Incoloy 800
→ Finned air heaters for dryers and AHUs
→ Tested before dispatch · 6-month guarantee

${WA}
#PharmaEquipment #Autoclave #ProcessEquipment #HeatingElements` },
  { key: 'w07', date: '2026-12-09', kind: 'expo', topic: 'Invite: Khadhya Khurak 2026', file: '/linkedin/w07.pdf', poster: '/phe-khadya-visitors-flyer.jpg',
    how: 'Document: Add a document → upload the PDF, title “You’re invited: Stall 254, Khadhya Khurak 2026”. Tag the organiser’s page.',
    comment: `Free entry, register as our guest: ${KK_LINK}`,
    caption: `You're invited! Meet us at Khadhya Khurak 2026.

📍 Stall 254, Hall 8 · Helipad Exhibition Centre, Sector 17, Gandhinagar
🗓 16–19 December · 10 AM – 6 PM

Bring a drawing, or the element you use today, and we'll go through it with you.
Free entry: registration link in the comments.

#KhadhyaKhurak2026 #FoodTech #Gandhinagar #HeatingElements` },
  { key: 'w08', date: '2026-12-16', kind: 'expo', topic: 'Day 1 at the expo', file: '/linkedin/w08.jpg', poster: '/linkedin/w08.jpg',
    how: 'Image: a photo of the stall and team taken that morning, by noon. The card here is the backup. Optional: one photo a day, 17–19 Dec.',
    caption: `Day 1 at Khadhya Khurak! 👋

Come and see our heating elements up close at Stall 254, Hall 8, Helipad Exhibition Centre, Gandhinagar. We're here till 19 December, 10 AM – 6 PM.

#KhadhyaKhurak2026 #FoodTech #Gandhinagar` },
  { key: 'w09', date: '2026-12-23', kind: 'video', topic: 'Tested before dispatch', file: '/linkedin/w09.mp4', poster: '/linkedin/w09.jpg', dur: '0:16',
    how: 'Video: upload the file as it is.',
    caption: `Every element is tested before it leaves us. ✅
That's why each one carries a 6-month guarantee.

Thank you to everyone who came to Stall 254 last week. We're following up with each of you.

${WA}
#QualityControl #Manufacturing #HeatingElements` },
  { key: 'w10', date: '2026-12-30', kind: 'flyer', topic: 'Gulf & Vietnam', file: '/linkedin/w10.pdf', poster: '/phe-oman-flyer.jpg',
    how: 'Document: Add a document → upload the PDF (3 pages: Oman, Qatar, Vietnam), title “Heating elements for the Gulf & Vietnam”.',
    caption: `Building equipment in the Gulf or Vietnam?

→ Elements made to your drawing in Ahmedabad
→ Stock in Sharjah (Peena Trading LLC) for faster Gulf delivery

Thank you for a great 2026. See you in the new year! 🎉
${WA}
#Exports #UAE #Oman #Qatar #Vietnam` },
];

export const KIND_LABEL = { video: 'Video', flyer: 'Flyer', greeting: 'Greeting', expo: 'Expo', photo: 'Photo' };
export const KIND_CLS = {
  video: 'bg-orange-100 text-orange-800', flyer: 'bg-sky-100 text-sky-800', greeting: 'bg-amber-100 text-amber-800',
  expo: 'bg-rose-100 text-rose-800', photo: 'bg-emerald-100 text-emerald-800',
};
