import {checkFeedAccess} from '../lib/fixture-refresh.mjs';
try{
  console.log(JSON.stringify(await checkFeedAccess()));
}catch(error){
  console.error(`FPL access check failed${error.status ? ` (HTTP ${error.status})` : ''}. No refresh or cutover performed.`);
  process.exitCode=1;
}
