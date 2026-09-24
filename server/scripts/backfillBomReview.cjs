require('dotenv').config({path:__dirname + '/../.env'});
const {getDB,initDB}=require('../src/db');
const {isSuspectLine}=require('../src/lib/bom');
const APPLY = process.argv.includes('--apply');

(async()=>{ await initDB(2,1000); const db=getDB();
  const items=await db.all(`
    SELECT oi.id, oi.quantity, oi.drawing_number, oi.product_code, oi.bom_review,
           o.order_code, o.status AS order_status, o.created_at
      FROM order_items oi JOIN orders o ON o.id=oi.order_id ORDER BY o.created_at DESC, oi.id`);
  const lines=await db.all(`
    SELECT oii.order_item_id, oii.qty, ii.unit, ii.item_code
      FROM order_item_inventory oii JOIN inventory_items ii ON ii.id=oii.inventory_item_id`);
  const byItem={}; lines.forEach(l=>(byItem[l.order_item_id]=byItem[l.order_item_id]||[]).push(l));

  // (a) verbatim carry-forward: same drawing + same part + identical qty, different item size
  const twins=await db.all(`
    SELECT DISTINCT a.oid
      FROM (SELECT oi.id oid, oi.drawing_number dn, oi.quantity q, oii.inventory_item_id ii, oii.qty bq
              FROM order_item_inventory oii JOIN order_items oi ON oi.id=oii.order_item_id WHERE oii.qty>0) a
      JOIN (SELECT oi.id oid, oi.drawing_number dn, oi.quantity q, oii.inventory_item_id ii, oii.qty bq
              FROM order_item_inventory oii JOIN order_items oi ON oi.id=oii.order_item_id WHERE oii.qty>0) b
        ON a.dn=b.dn AND a.ii=b.ii AND a.bq=b.bq AND a.q<>b.q AND a.oid<>b.oid`);
  const twinSet=new Set(twins.map(t=>t.oid));

  const flag=[];
  for(const it of items){
    if(it.bom_review) continue;
    const ls=byItem[it.id]||[]; if(!ls.length) continue;
    const odd=ls.filter(l=>isSuspectLine(l.qty,it.quantity,l.unit));
    const twin=twinSet.has(it.id);
    if(!odd.length && !twin) continue;
    const bits=[];
    if(twin) bits.push('This BOM is identical to another item on the same drawing with a different quantity, so one of the two was carried over without re-sizing.');
    if(odd.length) bits.push('These lines do not come to a whole number of pieces: '+odd.map(l=>`${l.item_code} ${l.qty} for ${it.quantity} pcs = ${+(l.qty/it.quantity).toFixed(3)}/pc`).join('; ')+'.');
    bits.push('Quantities were left exactly as they were — check them and correct if needed.');
    flag.push({...it, why:bits.join(' '), odd:odd.length, twin});
  }
  const LIVE=x=>!['dispatched','completed','cancelled','closed'].includes(x.order_status);
  const live=flag.filter(LIVE), hist=flag.filter(x=>!LIVE(x));
  console.log(`WOULD FLAG ${flag.length} item(s):  live ${live.length}  |  dispatched/closed ${hist.length}\n`);
  console.log('LIVE ONES (these are the ones design must action):');
  live.forEach(x=>console.log('  '+String(x.order_code).padEnd(12)+String(x.order_status).padEnd(21)+
    String(x.drawing_number||x.product_code||'').slice(0,28).padEnd(30)+'qty '+String(x.quantity).padStart(4)+
    '   '+(x.twin?'carry-forward':'')+(x.twin&&x.odd?' + ':'')+(x.odd?`${x.odd} fractional line(s)`:'')));

  if(!APPLY){ console.log('\n(dry run — nothing written. Pass --apply to flag them.)'); process.exit(0); }
  let n=0;
  await db.withTransaction(async(client)=>{
    for(const f of flag){
      await client.query("UPDATE order_items SET bom_review='needed', bom_review_reason=$1 WHERE id=$2 AND bom_review IS NULL",[f.why,f.id]);
      n++;
    }
  });
  console.log(`\nFLAGGED ${n} item(s). No quantity was changed.`);
  process.exit(0);
})().catch(e=>{console.error(e.stack);process.exit(1)});
