import {jsonFetch} from './http.mjs';
import {forecastPrompt,forecastSchema,parseStructuredForecast} from './structured-forecast.mjs';
import {providerMetadata,rejectedResponse} from './provider-usage.mjs';

function claudeForecastSchema() {
  const schema=forecastSchema();
  const properties=schema.properties.scoreProbabilities.properties;
  for(const key of Object.keys(properties)) properties[key]={type:'number'};
  return schema;
}

export async function predictClaude(match,{apiKey=process.env.ANTHROPIC_API_KEY,workspaceId=process.env.ANTHROPIC_WORKSPACE_ID}={}) {
  if(!apiKey) throw new Error('ANTHROPIC_API_KEY is not configured.');
  const body=await jsonFetch('https://api.anthropic.com/v1/messages',{
    method:'POST',headers:{...(workspaceId?{'anthropic-workspace-id':workspaceId}:{}),'x-api-key':apiKey,'anthropic-version':'2023-06-01','Content-Type':'application/json'},
    body:JSON.stringify({model:'claude-opus-5-5',max_tokens:4096,thinking:{type:'adaptive'},
      output_config:{effort:'low',format:{type:'json_schema',schema:claudeForecastSchema()}},
      messages:[{role:'user',content:forecastPrompt(match)}]}),
  },{attempts:1});
  const metadata=providerMetadata('claude',body);
  const text=Array.isArray(body?.content) ? body.content.filter(part=>part?.type==='text') : [];
  if(body?.stop_reason!=='end_turn' || text?.length!==1) throw rejectedResponse(metadata);
  return parseStructuredForecast(text[0].text,metadata);
}
