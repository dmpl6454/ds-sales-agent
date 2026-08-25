import { Pool } from 'pg'; import { readFileSync } from 'node:fs'
const env=readFileSync('.env','utf8')
const url=env.split('\n').find(l=>l.startsWith('DATABASE_URL='))!.split('=').slice(1).join('=').trim().replace(/^["']|["']$/g,'')
const pool=new Pool({connectionString:url,max:1})
async function main(){try{
const r=await pool.query(`select
  (select value from "Setting" where key='planLastOkAt') as plan_last_ok,
  round(extract(epoch from (now() - (select max("queuedAt") from "OutreachAttempt")))/60.0,1) as newest_draft_min_ago,
  (select count(*) from "OutreachAttempt" where status in ('READY','QUEUED')) as queue_depth,
  (select count(*) from "OutreachPair" p join "OutreachAttempt" a on a."pairId"=p.id
     join "TargetAccount" t on t.id=p."targetId"
    where a.status in ('READY','QUEUED') and t.handle in
    ('acharyavinodkumar','anandpandit','ananyapanday','arvindwriterdirector','azmishabana18','deepakmukut',
     'kunalkemmu','paradoxindia_','ritesh_sid','shekharravjiani','ushakakadeofficial','you_sunilsihaag')) as drafts_for_the_12`)
console.table(r.rows)
}finally{await pool.end()}}
main()
