// minimal in-memory D1 shim to exercise the worker logic end-to-end
class Stmt {
  constructor(db, sql){ this.db=db; this.sql=sql.trim(); this.args=[]; }
  bind(...a){ this.args=a; return this; }
  async run(){ return this.db._exec(this.sql,this.args); }
  async first(){ const r=this.db._exec(this.sql,this.args); return r.results[0]||null; }
  async all(){ return this.db._exec(this.sql,this.args); }
}
export class MockDB {
  constructor(){ this.t={users:[],sessions:[],tasks:[],bids:[],reviews:[],partner_merchants:[],payments:[],kyc_submissions:[],disputes:[],audit_log:[],rate_limits:[],vouchers:[],voucher_redemptions:[],settings:[],devices:[],notifications:[]}; }
  prepare(sql){ return new Stmt(this,sql); }
  async batch(stmts){ const out=[]; for(const s of stmts) out.push(this._exec(s.sql,s.args)); return out; }
  _table(sql){ const m=sql.match(/(?:FROM|INTO|UPDATE)\s+(\w+)/i); return m&&this.t[m[1]]?m[1]:null; }
  _exec(sql,args){
    const table=this._table(sql); const rows=table?this.t[table]:[];
    if(/^INSERT/i.test(sql)){
      const cols=sql.match(/\(([^)]+)\)\s*VALUES/i)[1].split(',').map(s=>s.trim());
      const valsPart=sql.slice(sql.search(/VALUES/i)+6);
      const rawVals=valsPart.match(/\(([\s\S]+)\)/)[1].split(',').map(s=>s.trim());
      const row={}; let ai2=0;
      cols.forEach((c,i)=>{
        const tok=rawVals[i];
        if(tok==='?'){ row[c]=args[ai2++]; }
        else if(/^'.*'$/.test(tok)){ row[c]=tok.slice(1,-1); }
        else if(/^-?\d+$/.test(tok)){ row[c]=parseInt(tok,10); }
        else { row[c]=args[ai2++]; }
      });
      // UNIQUE guards
      if(table==='bids' && rows.find(r=>r.task_id===row.task_id&&r.partner_id===row.partner_id)) throw new Error('UNIQUE');
      if(table==='reviews' && rows.find(r=>r.task_id===row.task_id&&r.rater_id===row.rater_id)) throw new Error('UNIQUE');
      if(/ON CONFLICT/i.test(sql)){ const ex=rows.find(r=>r.user_id===row.user_id); if(ex){ex.balance_cents=args[args.length-2];ex.updated_at=args[args.length-1];return{results:[]};} }
      rows.push(row); return {results:[]};
    }
    if(/^UPDATE/i.test(sql)){
      const setPart=sql.match(/SET\s+([\s\S]+?)\s+WHERE/i)[1];
      const assigns=setPart.split(',').map(x=>x.trim()); // e.g. status='inprogress'  or balance_cents=?
      const whereClause=sql.match(/WHERE\s+([\s\S]+)$/i)[1].trim();
      // build setters, consuming ? args in order
      let ai=0; const setters=[];
      for(const a of assigns){
        const [col,rhs]=a.split('=').map(x=>x.trim());
        if(rhs==='?'){ const v=args[ai++]; setters.push([col,()=>v]); }
        else if(/^'.*'$/.test(rhs)){ const v=rhs.slice(1,-1); setters.push([col,()=>v]); }
        else if(/^-?\d+$/.test(rhs)){ const v=parseInt(rhs,10); setters.push([col,()=>v]); }
        else { const v=args[ai++]; setters.push([col,()=>v]); }
      }
      // where: support "id=?", "user_id=?", and "task_id=? AND id!=?"
      const wConds=whereClause.split(/AND/i).map(x=>x.trim());
      const wReq=[];
      for(const c of wConds){
        if(/!=\s*\?/.test(c)){ const col=c.split('!=')[0].trim(); wReq.push(['ne',col,args[ai++]]); }
        else if(/=\s*\?/.test(c)){ const col=c.split('=')[0].trim(); wReq.push(['eq',col,args[ai++]]); }
      }
      for(const r of rows){
        let match=true;
        for(const [op,col,val] of wReq){
          if(op==='eq' && String(r[col])!==String(val)) match=false;
          if(op==='ne' && String(r[col])===String(val)) match=false;
        }
        if(match) for(const [col,fn] of setters) r[col]=fn();
      }
      return {results:[]};
    }
    if(/^DELETE/i.test(sql)){ const wc=sql.match(/WHERE\s+(\w+)/i)[1]; const wv=args[0]; this.t[table]=rows.filter(r=>r[wc]!==wv); return {results:[]}; }
    if(/^SELECT/i.test(sql)){
      // aggregates: COUNT(*) alias, COALESCE(SUM(expr),0) alias, AVG(rating)
      if(/COUNT\(\*\)|SUM\(|AVG\(/i.test(sql)){
        const f=this._filter(sql,args,rows); const out={};
        const cm=sql.match(/COUNT\(\*\)\s+(\w+)/i); if(cm) out[cm[1]]=f.length;
        const evalExpr=(row,expr)=>{ let total=0,sign=1;
          for(const tok of expr.split(/([+\-])/)){ const t=tok.trim(); if(t==='+' ){sign=1;} else if(t==='-'){sign=-1;} else if(t){ total+=sign*((row[t]||0)); } }
          return total; };
        const sre=/COALESCE\(SUM\(([^)]+)\),0\)\s+(\w+)/gi; let m;
        while((m=sre.exec(sql))){ const expr=m[1],alias=m[2]; out[alias]=f.reduce((s,r)=>s+evalExpr(r,expr),0); }
        if(/AVG\(rating\)/i.test(sql)){ out.avg=f.length?f.reduce((s,r)=>s+r.rating,0)/f.length:0; if(!('n' in out)) out.n=f.length; }
        if(Object.keys(out).length) return {results:[out]};
      }
      let f=this._filter(sql,args,rows);
      // minimal JOIN users support: attach aliased user columns (e.g. "u.name pname")
      if(/JOIN\s+users\s+u\s+ON\s+u\.id\s*=\s*\w+\.(\w+)/i.test(sql)){
        const jk = sql.match(/JOIN\s+users\s+u\s+ON\s+u\.id\s*=\s*\w+\.(\w+)/i)[1];
        const sel = sql.slice(0, sql.search(/FROM/i));
        const pairs = [...sel.matchAll(/u\.(\w+)\s+(\w+)/g)].map(m=>[m[1],m[2]]);
        f = f.map(r=>{ const u=this.t.users.find(x=>x.id===r[jk]); const o={...r};
          for(const [col,alias] of pairs) o[alias]=u?u[col]:null; return o; });
      }
      return {results:f};
    }
    return {results:[]};
  }
  _filter(sql,args,rows){
    // handle the common WHERE col=? [AND col=?] patterns we actually use
    const wm=sql.match(/WHERE\s+(.+?)(?:ORDER|LIMIT|$)/i); if(!wm) return rows.slice();
    let clause=wm[1]; let ai=0; let f=rows.slice();
    // strip table alias prefixes like b. t. u. r.
    clause=clause.replace(/\b[a-z]\./g,'');
    const conds=clause.split(/AND/i).map(s=>s.trim()).filter(Boolean);
    for(const c of conds){
      if(c.includes('BETWEEN')){ const col=c.split('BETWEEN')[0].trim(); const lo=args[ai++],hi=args[ai++]; f=f.filter(r=>r[col]>=lo&&r[col]<=hi); }
      else if(/!=\s*\?/.test(c)){ const col=c.split('!=')[0].trim(); const v=args[ai++]; f=f.filter(r=>r[col]!==v); }
      else if(/=\s*\?/.test(c)){ const col=c.split('=')[0].trim(); const v=args[ai++]; f=f.filter(r=>String(r[col])===String(v)); }
      // literal comparisons on ANY column, e.g. mode='partner', suspended=0, status='open'.
      // (This used to only understand status='...', so other literal conditions were
      //  silently ignored and tests passed when real D1 would have filtered.)
      else if(/^\s*(\w+)\s*=\s*'([^']*)'\s*$/.test(c)){
        const m=c.match(/^\s*(\w+)\s*=\s*'([^']*)'\s*$/); f=f.filter(r=>String(r[m[1]])===m[2]); }
      else if(/^\s*(\w+)\s*=\s*(-?\d+(?:\.\d+)?)\s*$/.test(c)){
        const m=c.match(/^\s*(\w+)\s*=\s*(-?\d+(?:\.\d+)?)\s*$/); f=f.filter(r=>Number(r[m[1]])===Number(m[2])); }
      else if(/^\s*(\w+)\s*!=\s*'([^']*)'\s*$/.test(c)){
        const m=c.match(/^\s*(\w+)\s*!=\s*'([^']*)'\s*$/); f=f.filter(r=>String(r[m[1]])!==m[2]); }
    }
    return f;
  }
}
