import {pathToFileURL} from 'node:url';
import {getStore,closeDatabase} from '../lib/store.mjs';
import {refreshFixtures} from '../lib/fixture-refresh.mjs';

export async function main({env=process.env,storeFactory=getStore,refresh=refreshFixtures,close=closeDatabase}={}) {
  try{
    if(env.PERSISTENCE_BACKEND!=='neon' || !env.DATABASE_URL || env.DATABASE_SCHEMA!=='epl_oracle')throw new Error('Missing explicit production configuration');
    const result=await refresh(storeFactory());
    console.log(JSON.stringify(result));
    return 0;
  }catch(error){
    console.error(`Fixture refresh failed${error.status ? ` (HTTP ${error.status})` : ''}. Check configuration and workflow logs; retained data is unchanged on failure.`);
    return 1;
  }finally{await close();}
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href)process.exitCode=await main();
