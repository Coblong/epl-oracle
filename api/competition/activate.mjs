import {getStore} from '../../lib/store.mjs';
import {authorizeCron} from '../../lib/cron-auth.mjs';

const json=(res,status,data)=>{res.statusCode=status;res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');res.end(JSON.stringify(data));};

export default async function handler(req,res){
  if(req.method!=='POST')return json(res,405,{error:'Method not allowed'});
  if(!process.env.CRON_SECRET)return json(res,503,{error:'Competition activation is not configured.'});
  if(!authorizeCron(req))return json(res,401,{error:'Unauthorized'});
  if(process.env.PERSISTENCE_BACKEND!=='neon')return json(res,409,{error:'Competition activation requires validated Neon persistence.'});
  try{return json(res,200,{competition:await getStore().activateCompetition(new Date().toISOString())});}
  catch{return json(res,502,{error:'Unable to activate competition. Check server configuration.'});}
}
