import type { VaultSnapshot } from '../lib/types';
import { ratio, subtract, add, units, money, type Money } from './money';
export function allocate(s:VaultSnapshot,resourceId:string,date:string,cost:Money){
 const rule=s.allocationRules?.find(r=>r.resourceId===resourceId&&r.effectiveFrom<=date&&(!r.effectiveTo||date<r.effectiveTo));
 let idle=cost;
 const shares=(rule?.shares??[]).map(share=>{const amount=ratio(cost,share.weight);idle=subtract(idle,amount);return {projectId:share.projectId,amount};});
 // Round each project's share once; the final project absorbs a one-unit rounding excess.
 if(units(idle)*units(cost)<0n&&shares.length){const last=shares[shares.length-1];last.amount=add(last.amount,idle);idle=money('0',idle.asset);}
 return {ruleId:rule?.id,shares,idle};
}
