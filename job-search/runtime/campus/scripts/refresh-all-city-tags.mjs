import {main} from '../../../../shared/job-search-core/scripts/refresh-cities.mjs';
await main(process.argv.slice(2)).then(r=>console.log(JSON.stringify(r)));
