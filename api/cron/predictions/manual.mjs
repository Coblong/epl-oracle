import {getStore} from '../../../lib/store.mjs';
import {generateCompetitionPredictions,competitionRunContext} from '../../../lib/weekly-predictions.mjs';
import {authorizeCron} from '../../../lib/cron-auth.mjs';
import {PREDICTORS} from '../../../lib/providers.mjs';

const json=(res,status,data)=>{res.statusCode=status;res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');res.end(JSON.stringify(data));};

export default async function handler(req,res){
  if(req.method!=='POST')return json(res,405,{error:'Method not allowed'});
  if(!process.env.CRON_SECRET)return json(res,503,{error:'Manual predictions are not configured.'});
  if(!authorizeCron(req))return json(res,401,{error:'Unauthorized'});
  if(process.env.PERSISTENCE_BACKEND!=='neon')return json(res,409,{error:'Manual predictions require validated Neon persistence.'});
  try{
    const store=getStore();
    const competition=await store.getCompetition();
    if(!competition?.active||!competition.startedAt)return json(res,409,{error:'Competition is not active.'});
    const now=new Date();
    const context=competitionRunContext(competition.startedAt,now);
    if(!context)return json(res,409,{error:'The activation run is outside its retry window.'});
    const stats=await generateCompetitionPredictions(store,PREDICTORS,competition.startedAt,now);
    return json(res,200,{ok:true,run:context.key,...stats});
  }catch{
    console.error('Manual competition prediction run failed. Check server configuration.');
    return json(res,502,{error:'Unable to run competition predictions. Check server configuration and retry.'});
  }
}
