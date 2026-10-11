'use strict';
(() => {
  const el = (tag, props = {}, children = []) => {
    const node = document.createElement(tag);
    for (const [key,value] of Object.entries(props || {})) {
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value == null ? '' : String(value);
      else if (key === 'onClick') node.addEventListener('click',value);
      else if (key === 'value') node.value = value == null ? '' : String(value);
      else if (key === 'checked') node.checked = Boolean(value);
      else if (key === 'disabled') node.disabled = Boolean(value);
      else if (key === 'hidden') node.hidden = Boolean(value);
      else node.setAttribute(key,value);
    }
    for (const child of children || []) if (child) node.append(child);
    return node;
  };
  const text = (v,fallback='—') => v === null || v === undefined || v === '' ? fallback : String(v);
  const num = v => (Number(v)||0).toLocaleString('bn-BD');
  const dateText = value => { if(!value) return '—'; try { return new Intl.DateTimeFormat('bn-BD',{dateStyle:'medium'}).format(new Date(value)); } catch(_) { return String(value); } };
  const money = value => { try { return new Intl.NumberFormat('bn-BD',{style:'currency',currency:'BDT',maximumFractionDigits:2}).format(Number(value)||0); } catch(_) { return '৳'+num(value); } };
  const badge = (label,kind='') => el('span',{class:'console-badge'+(kind?' '+kind:''),text:label});
  const panel = (title,description,content) => el('section',{class:'console-panel'},[el('h2',{text:title}),description?el('p',{text:description}):null,content]);
  const stat = (label,value,note='') => el('article',{class:'console-stat'},[el('span',{class:'console-stat-label',text:label}),el('strong',{class:'console-stat-value',text:value}),note?el('span',{class:'console-stat-note',text:note}):null]);
  const field = (label,control,className='') => el('label',{class:'form-field'+(className?' '+className:'')},[el('span',{text:label}),control]);
  const select = (options,value='') => { const node=el('select'); options.forEach(([v,l])=>node.append(el('option',{value:v,text:l}))); node.value=value; return node; };
  const button = (label,fn,className='console-small-button') => el('button',{type:'button',class:className,text:label,onClick:fn});
  const heading = (eyebrow,title,description) => el('div',{class:'console-heading'},[el('div',{},[el('span',{class:'section-kicker',text:eyebrow}),el('h1',{text:title}),el('p',{text:description})])]);
  const table = (headers,rows) => { const t=el('table',{class:'console-table'}), thead=el('thead'),tr=el('tr'); headers.forEach(h=>tr.append(el('th',{text:h}))); thead.append(tr); const body=el('tbody'); rows.forEach(row=>body.append(row)); t.append(thead,body); return el('div',{class:'console-table-wrap'},[t]); };
  const cell = (...children) => el('td',{},children);
  const tr = (...cells) => el('tr',{},cells);
  const empty = message => el('div',{class:'console-empty',text:message});
  const statusBadge = value => { const labels={active:'Active',paused:'Paused',draft:'Draft',removed:'Removed',suspended:'Suspended',banned:'Banned',enabled:'Monetized',pending:'Pending',appealed:'Appealed',dismissed:'Dismissed',resolved:'Resolved',rejected:'Rejected'}; const kind=['active','enabled','resolved'].includes(value)?'good':['removed','banned','rejected'].includes(value)?'bad':['paused','suspended','pending','appealed'].includes(value)?'warn':''; return badge(labels[value]||value||'—',kind); };
  const safeAppealText = t => String(t||'').slice(0,2000);

  async function renderStudio(app,ctx) {
    app.replaceChildren(heading('CREATOR STUDIO','তোমার channel-এর পরিসংখ্যান','Views, engagement, subscriber growth এবং ad performance এক জায়গায় দেখো।'));
    const range=select([['7','৭ দিন'],['30','৩০ দিন'],['90','৯০ দিন']],'30');
    const rangeWrap=el('div',{class:'console-panel'},[el('div',{class:'console-form'},[field('সময়সীমা',range)])]); app.append(rangeWrap,el('div',{class:'console-grid'},[stat('পরিসরের views','…'),stat('মোট subscribers','…'),stat('মোট likes','…'),stat('ভিডিও', '…')]));
    const loading=panel('পরিসংখ্যান','তথ্য লোড হচ্ছে…',empty('একটু অপেক্ষা করো।')); app.append(loading);
    async function load() {
      try {
        const data=await ctx.jsonFetch('/api/creator/analytics?days='+encodeURIComponent(range.value));
        const totals=data.totals||{}, ads=data.ads||{};
        app.replaceChildren(heading('CREATOR STUDIO','তোমার channel-এর পরিসংখ্যান','Views, engagement, subscriber growth এবং ad performance এক জায়গায় দেখো।'),rangeWrap,
          el('div',{class:'console-grid'},[stat('মোট views',num(totals.views),'নির্বাচিত সময়ের chart নিচে'),stat('Subscribers',num(totals.subscribers),'বর্তমান channel followers'),stat('মোট likes',num(totals.likes),'সব ভিডিও মিলিয়ে'),stat('ভিডিও',num(totals.videos),'আপলোড করা সব ভিডিও')]));
        rangeWrap.querySelector('select').value=String(data.days||range.value);
        const points=(data.viewsByDay||[]).slice(-14); const max=Math.max(1,...points.map(x=>Number(x.views)||0));
        const chart=el('div',{class:'console-chart'});
        points.forEach(point=>{const bar=el('div',{class:'console-chart-bar',style:''});bar.style.height=Math.max(3,Math.round((Number(point.views)||0)/max*88))+'px';bar.title=num(point.views)+' views · '+point.day;bar.append(el('span',{text:String(point.day||'').slice(5)}));chart.append(bar);});
        if(!points.length) chart.append(empty('এখনো chart data নেই।'));
        app.append(panel('Views trend','শেষ '+num(data.days)+' দিনের recorded unique views',chart));
        const rows=(data.videos||[]).map(video=>tr(cell(el('strong',{text:video.title}),el('div',{class:'console-muted',text:dateText(video.createdAt)})),cell(num(video.views)),cell(num(video.likes)),cell(num(video.comments)),cell(statusBadge(video.moderationStatus)),cell(money(video.estimatedEarningsBdt))));
        app.append(panel('তোমার ভিডিও','Ad earnings হলো আনুমানিক হিসাব—এটি payout নয়। এই app বর্তমানে watch-time মাপে না.',rows.length?table(['ভিডিও','Views','Likes','Comments','Status','আনুমানিক আয়'],rows):empty('এখনো কোনো ভিডিও নেই।')));
        const statusText=data.monetizationStatus==='enabled'?'চ্যানেল monetization-এ অনুমোদিত।':data.monetizationStatus==='paused'?'Monetization বর্তমানে pause করা।':data.monetizationStatus==='rejected'?'Monetization অনুমোদিত হয়নি।':'Monetization approval-এর অপেক্ষায়।';
        const notice=el('div',{class:'console-notice',text:statusText+' Real payout ও payment method এখনো যুক্ত নয়।'});
        const summary=el('div',{class:'console-grid'},[stat('Ad impressions',num(ads.impressions)),stat('Ad clicks',num(ads.clicks)),stat('Estimated creator earnings',money(ads.estimatedEarningsBdt),'যাচাই করা payment নয়'),stat('Active copyright strikes',num(data.activeStrikes))]);
        app.append(panel('Monetization & ads','বর্তমান ad campaigns থেকে মাপা পরিসংখ্যান।',el('div',{},[notice,summary])));
        const strikeData=await ctx.jsonFetch('/api/creator/strikes').catch(()=>({strikes:[]}));
        const strikeRows=(strikeData.strikes||[]).map(item=>{
          const reason=el('div',{class:'console-muted',text:item.reason});
          const content=el('div',{},[el('strong',{text:item.videoTitle}),el('div',{class:'console-muted',text:dateText(item.createdAt)}),reason,item.appealText?el('div',{class:'console-muted',text:'আপিল: '+item.appealText}):null]);
          if(item.status==='active'){
            const appeal=el('textarea',{maxlength:'2000',rows:'2',placeholder:'আপিলের কারণ (কমপক্ষে ১০ অক্ষর)'});
            content.append(appeal,button('আপিল পাঠাও',async()=>{try{await ctx.jsonFetch('/api/creator/strikes/'+encodeURIComponent(item.id)+'/appeal',{method:'POST',body:{appeal:safeAppealText(appeal.value)}});ctx.notify('আপিল জমা হয়েছে।');await load();}catch(error){ctx.notify(error.message,'error');}},'console-small-button'));
          }
          return tr(cell(content),cell(statusBadge(item.status)));
        });
        app.append(panel('Copyright notices','Internal moderation records. Appeal পাঠালে site admin review করবে.',strikeRows.length?table(['Notice','Status'],strikeRows):empty('কোনো active strike নেই।')));
      } catch(error) { app.replaceChildren(heading('CREATOR STUDIO','তথ্য লোড হয়নি','আবার চেষ্টা করো।'),el('div',{class:'console-notice',text:error.message})); }
    }
    range.addEventListener('change',load);
    await load();
  }

  async function renderAdmin(app,ctx,chosenTab) {
    const queryTab=new URLSearchParams(location.search).get('tab');
    const tabs=[['overview','Overview'],['ads','Ads'],['moderation','Moderation'],['staff','Admin roles'],['settings','Platform settings'],['audit','Audit log']];
    const role=ctx.adminRole;
    if(!role){app.replaceChildren(heading('CLIPNEST ADMIN','অনুমতি নেই','এই panel শুধু অনুমোদিত Admin/Moderator-এর জন্য।'));return;}
    let activeTab=chosenTab||queryTab||'overview';
    if((['ads','audit'].includes(activeTab)&&!['owner','admin'].includes(role))||(['staff','settings'].includes(activeTab)&&role!=='owner')) activeTab='overview';
    app.replaceChildren(heading('CLIPNEST ADMIN','Admin control panel','নিরাপদ staff roles, ads, monetization controls এবং creator/content moderation.'));
    const nav=el('nav',{class:'console-tabs','aria-label':'Admin sections'});
    tabs.forEach(([id,label])=>{if(id==='staff'&&role!=='owner')return;if(id==='settings'&&role!=='owner')return;if(['ads','audit'].includes(id)&&!['owner','admin'].includes(role))return;nav.append(el('button',{type:'button',class:'console-tab'+(activeTab===id?' active':''),text:label,onClick:()=>ctx.navigate('/admin?tab='+id)}));});
    app.append(nav,el('div',{class:'console-notice',text:'Owner email server-side-এ যাচাই হয়। Moderation action-গুলো reversible record হিসেবে রাখা হয়; video remove করলে R2 file স্থায়ীভাবে মুছে যায় না।'}));
    const content=el('div');app.append(content);
    try {
      if(activeTab==='overview') {
        const [overview,audit]=await Promise.all([ctx.jsonFetch('/api/admin/overview'),ctx.jsonFetch('/api/admin/audit?limit=8').catch(()=>({events:[]}))]);
        const c=overview.counts||{},a=overview.ads||{},s=overview.settings||{};
        content.append(el('div',{class:'console-grid'},[stat('Accounts',num(c.users)),stat('Visible videos',num(c.videos)),stat('Open strikes',num(c.openStrikes)),stat('Active ad campaigns',num(c.activeCampaigns))]));
        content.append(panel('Ads & monetization status','Public ads default-off; Owner Platform settings-এ চালু করতে হবে।',el('div',{class:'console-grid'},[stat('Ads',s.adsEnabled?'চালু':'বন্ধ'),stat('Monetization',s.monetizationEnabled?'চালু':'বন্ধ'),stat('Creator share',s.creatorSharePercent==null?'Set করা নেই':num(s.creatorSharePercent)+'%'),stat('Ad impressions',num(a.impressions))])));
        const rows=(audit.events||[]).map(x=>tr(cell(el('strong',{text:x.action}),el('div',{class:'console-muted',text:x.reason||'—'})),cell(x.actorEmail),cell(dateText(x.createdAt)),cell(x.targetType+': '+text(x.targetId))));
        content.append(panel('Recent admin actions','Audit trail-এ action, actor ও reason নথিভুক্ত হয়.',rows.length?table(['Action','Admin','Date','Target'],rows):empty('এখনো কোনো admin action নেই।')));
      } else if(activeTab==='ads') await renderAds(content,ctx,role);
      else if(activeTab==='moderation') await renderModeration(content,ctx,role);
      else if(activeTab==='staff'&&role==='owner') await renderStaff(content,ctx);
      else if(activeTab==='settings'&&role==='owner') await renderSettings(content,ctx);
      else if(activeTab==='audit') {
        const data=await ctx.jsonFetch('/api/admin/audit?limit=100');
        const rows=(data.events||[]).map(x=>tr(cell(el('strong',{text:x.action}),el('div',{class:'console-muted',text:x.reason||'—'})),cell(x.actorEmail+' · '+x.actorRole),cell(dateText(x.createdAt)),cell(x.targetType+': '+text(x.targetId)),cell(JSON.stringify(x.metadata||{}).slice(0,180))));
        content.append(panel('Audit log','Sensitive admin changes traceable রাখা হয়.',rows.length?table(['Action','Actor','Date','Target','Details'],rows):empty('Audit event নেই।')));
      }
    } catch(error) { content.append(el('div',{class:'console-notice',text:error.message})); }
  }

  async function renderAds(root,ctx,role) {
    root.replaceChildren();
    const [campaignData,settings]=await Promise.all([ctx.jsonFetch('/api/admin/campaigns'),ctx.jsonFetch('/api/admin/settings').catch(()=>({}))]);
    root.append(panel('Campaign controls','নতুন campaign default-ভাবে Paused থাকবে। কোনো বাইরের ad network বা payout provider এখানে সংযুক্ত নয়.',el('div',{class:'console-grid'},[stat('Ads delivery',settings.adsEnabled?'চালু':'বন্ধ'),stat('Creator monetization',settings.monetizationEnabled?'চালু':'বন্ধ'),stat('Creator share',settings.creatorSharePercent==null?'Set করা নেই':num(settings.creatorSharePercent)+'%'),stat('Campaigns',num((campaignData.campaigns||[]).length))])));
    const title=el('input',{type:'text',maxlength:'120',required:'',placeholder:'যেমন: Brand campaign'});
    const sponsor=el('input',{type:'text',maxlength:'120',required:'',placeholder:'Sponsor name'});
    const placement=select([['feed','Home feed card'],['watch_sidebar','Watch page sidebar']]);
    const creative=el('input',{type:'url',required:'',placeholder:'https://.../campaign-image.jpg'});
    const destination=el('input',{type:'url',required:'',placeholder:'https://sponsor.example'});
    const cpm=el('input',{type:'number',min:'0',max:'1000000',step:'0.01',value:'0',required:''});
    const starts=el('input',{type:'datetime-local'}),ends=el('input',{type:'datetime-local'});
    const form=el('form',{class:'console-form'},[field('Campaign title',title),field('Sponsor',sponsor),field('Placement',placement),field('CPM (BDT / 1,000 impressions)',cpm),field('Creative image URL (HTTPS)',creative,'span-2'),field('Landing page URL (HTTPS)',destination,'span-2'),field('Start (optional)',starts),field('End (optional)',ends),el('div',{class:'console-form-actions'},[el('button',{type:'submit',class:'primary-cta',text:'Paused campaign তৈরি করো'})])]);
    form.addEventListener('submit',async event=>{event.preventDefault();const submit=form.querySelector('[type="submit"]');submit.disabled=true;try{await ctx.jsonFetch('/api/admin/campaigns',{method:'POST',body:{title:title.value,sponsorName:sponsor.value,placement:placement.value,creativeUrl:creative.value,destinationUrl:destination.value,cpmBdt:Number(cpm.value),startsAt:starts.value?new Date(starts.value).toISOString():null,endsAt:ends.value?new Date(ends.value).toISOString():null}});ctx.notify('Campaign তৈরি হয়েছে—এখন Paused.');await renderAds(root,ctx,role);}catch(error){ctx.notify(error.message,'error');}finally{submit.disabled=false;}});
    root.append(panel('নতুন campaign','শুধু HTTPS URL গ্রহণ করা হয়. Campaign activate এবং global ads enable না করা পর্যন্ত visitors-কে ads দেখানো হবে না.',form));
    const rows=(campaignData.campaigns||[]).map(c=>tr(cell(el('strong',{text:c.title}),el('div',{class:'console-muted',text:c.sponsorName+' · '+(c.placement==='feed'?'Feed':'Watch page')})),cell(statusBadge(c.status)),cell(num(c.impressions)),cell(num(c.clicks)),cell(money(c.cpmBdt)+' CPM'),cell(el('div',{class:'console-actions'},[button(c.status==='active'?'Pause':'Activate',async()=>{try{await ctx.jsonFetch('/api/admin/campaigns/'+encodeURIComponent(c.id)+'/status',{method:'PATCH',body:{status:c.status==='active'?'paused':'active'}});ctx.notify('Campaign status update হয়েছে।');await renderAds(root,ctx,role);}catch(error){ctx.notify(error.message,'error');}})]))));
    root.append(panel('Campaign list','CPM এবং creator revenue estimate-এর হিসাব কোনো confirmed advertiser payment নয়.',rows.length?table(['Campaign','Status','Impressions','Clicks','Rate','Action'],rows):empty('এখনো campaign নেই।')));
  }

  async function renderModeration(root,ctx,role) {
    const q=el('input',{type:'search',placeholder:'ভিডিও title, channel বা email খুঁজুন'});
    const searchButton=el('button',{type:'button',class:'primary-cta',text:'খুঁজুন'});
    const searchBar=el('div',{class:'console-form'},[field('Search',q,'span-2'),el('div',{class:'console-form-actions'},[searchButton])]);
    root.append(panel('Content & channel search','Video takedown/restore reversible; copyright strike creator dashboard-এ দেখা যাবে; ban/suspend user actions বন্ধ করবে.',searchBar));
    const targetPanel=el('div');root.append(targetPanel);
    async function loadContent() {
      try {
        const data=await ctx.jsonFetch('/api/admin/content?q='+encodeURIComponent(q.value.trim()));
        targetPanel.replaceChildren();
        const videoOptions=[['','— Video বেছে নিন —'],...(data.videos||[]).map(v=>[v.id,(v.title||v.id)+' · '+(v.handle?'@'+v.handle:'no channel')+' · '+(v.moderationStatus||'active')])];
        const channelOptions=[['','— Channel বেছে নিন —'],...(data.channels||[]).map(c=>[c.userSub,(c.displayName||c.handle||c.email)+' · '+(c.handle?'@'+c.handle:'no handle')+' · '+c.status])];
        const strikeOptions=[['','— Strike বেছে নিন —'],...(data.strikes||[]).filter(s=>['active','appealed'].includes(s.status)).map(s=>[s.id,(s.videoTitle||s.id)+' · '+(s.handle?'@'+s.handle:'channel')+' · '+s.status])];
        const action=select([['remove_video','ভিডিও site থেকে সরাও'],['restore_video','ভিডিও restore করো'],['copyright_strike','Copyright strike + remove'],['suspend_channel','Channel suspend'],['ban_channel','Channel ban'],['unban_channel','Channel unban'],['dismiss_strike','Strike dismiss'],['resolve_strike','Strike resolve']]);
        const video=select(videoOptions),channel=select(channelOptions),strike=select(strikeOptions);
        const reason=el('textarea',{maxlength:'2000',rows:'3',required:'',placeholder:'কারণ লিখুন—এটি audit log ও creator notice-এ থাকবে'});
        const evidence=el('input',{type:'url',placeholder:'Evidence link (optional, HTTPS)'});
        const targetFields=el('div',{class:'console-form span-2'},[field('Action',action),field('Video',video),field('Channel',channel),field('Strike',strike),field('Reason',reason,'span-2'),field('Evidence URL (copyright strike)',evidence,'span-2')]);
        const showTargets=()=>{video.parentElement.hidden=!['remove_video','restore_video','copyright_strike'].includes(action.value);channel.parentElement.hidden=!['suspend_channel','ban_channel','unban_channel'].includes(action.value);strike.parentElement.hidden=!['dismiss_strike','resolve_strike'].includes(action.value);evidence.parentElement.hidden=action.value!=='copyright_strike';};
        action.addEventListener('change',showTargets);showTargets();
        const run=el('button',{type:'button',class:'primary-cta',text:'Moderation action চালাও'});
        run.addEventListener('click',async()=>{if(!confirm('এই moderation action-টি নথিভুক্ত ও কার্যকর করবে—চালিয়ে যাবেন?'))return;run.disabled=true;try{const body={action:action.value,reason:reason.value,evidenceUrl:evidence.value||undefined};if(video.value)body.videoId=video.value;if(channel.value)body.userSub=channel.value;if(strike.value)body.strikeId=strike.value;await ctx.jsonFetch('/api/admin/actions',{method:'POST',body});ctx.notify('Action সম্পন্ন হয়েছে এবং audit log-এ রাখা হয়েছে।');await loadContent();}catch(error){ctx.notify(error.message,'error');}finally{run.disabled=false;}});
        const form=el('div',{class:'console-form'},[targetFields,el('div',{class:'console-form-actions'},[run])]);
        targetPanel.append(panel('Moderation action','Copyright strike হলো এই সাইটের internal moderation record; এটি নিজে থেকে আইনগত বা platform-level copyright decision নয়.',form));
        if(role==='owner') {
          const rows=(data.channels||[]).map(c=>{const mon=select([['pending','Pending'],['enabled','Enable'],['paused','Pause'],['rejected','Reject']],c.monetizationStatus||'pending');const apply=button('Save',async()=>{try{await ctx.jsonFetch('/api/admin/creators/'+encodeURIComponent(c.userSub)+'/monetization',{method:'POST',body:{status:mon.value,reason:'Owner reviewed creator eligibility'}});ctx.notify('Creator monetization status update হয়েছে।');await loadContent();}catch(error){ctx.notify(error.message,'error');}});return tr(cell(el('strong',{text:c.displayName||c.email}),el('div',{class:'console-muted',text:'@'+(c.handle||'—')+' · '+c.email})),cell(statusBadge(c.status)),cell(statusBadge(c.monetizationStatus||'pending')),cell(el('div',{class:'console-actions'},[mon,apply])));});
          targetPanel.append(panel('Creator monetization approval','Owner-only. Approval চালু করলেই payout তৈরি হয় না; platform monetization settings-ও enable থাকতে হবে.',rows.length?table(['Creator','Channel status','Monetization','Update'],rows):empty('Creator নেই।')));
        }
        const strikeRows=(data.strikes||[]).map(s=>tr(cell(el('strong',{text:s.videoTitle||'Video removed'}),el('div',{class:'console-muted',text:(s.displayName||s.handle||s.channelSub||'Channel')+' · '+dateText(s.createdAt)}),el('div',{class:'console-muted',text:s.reason})),cell(statusBadge(s.status))));
        targetPanel.append(panel('Copyright strike records','Appealed notices এখানে status-সহ review করা যায়।',strikeRows.length?table(['Notice','Status'],strikeRows):empty('Strike record নেই।')));
      } catch(error) {targetPanel.replaceChildren(el('div',{class:'console-notice',text:error.message}));}
    }
    searchButton.addEventListener('click',loadContent);q.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();loadContent();}});
    await loadContent();
  }

  async function renderStaff(root,ctx) {
    root.replaceChildren();
    const data=await ctx.jsonFetch('/api/admin/members');
    const email=el('input',{type:'email',maxlength:'254',required:'',placeholder:'staff@example.com'});
    const role=select([['admin','Admin'],['moderator','Moderator']]);
    const form=el('form',{class:'console-form'},[field('Google login email',email),field('Role',role),el('div',{class:'console-form-actions'},[el('button',{type:'submit',class:'primary-cta',text:'Staff যোগ/আপডেট'})])]);
    form.addEventListener('submit',async event=>{event.preventDefault();try{await ctx.jsonFetch('/api/admin/members',{method:'POST',body:{email:email.value,role:role.value}});ctx.notify('Staff role update হয়েছে।');await renderStaff(root,ctx);}catch(error){ctx.notify(error.message,'error');}});
    root.append(panel('Admin ও Moderator যোগ','শুধু verified Google account-এর email দিন। Bootstrap Owner-কে সরানো যাবে না.',form));
    const rows=(data.members||[]).map(m=>tr(cell(el('strong',{text:m.email}),m.protected?el('div',{class:'console-muted',text:'Bootstrap owner'}):null),cell(statusBadge(m.role,m.role==='owner'?'good':'')),cell(m.createdAt?dateText(m.createdAt):'Environment'),cell(m.protected?el('span',{class:'console-muted',text:'Protected'}):button('Remove',async()=>{if(!confirm('এই staff access সরাবেন?'))return;try{await ctx.jsonFetch('/api/admin/members/'+encodeURIComponent(m.email),{method:'DELETE'});ctx.notify('Staff access সরানো হয়েছে।');await renderStaff(root,ctx);}catch(error){ctx.notify(error.message,'error');}},'console-small-button console-danger'))));
    root.append(panel('বর্তমান staff','Admin campaign ও moderation পরিচালনা করতে পারে; Moderator moderation-এ সীমিত.',rows.length?table(['Google account','Role','Added','Access'],rows):empty('অন্য staff যোগ করা হয়নি।')));
  }

  async function renderSettings(root,ctx) {
    root.replaceChildren();
    const data=await ctx.jsonFetch('/api/admin/settings');
    const ads=el('input',{type:'checkbox',checked:data.adsEnabled});
    const monet=el('input',{type:'checkbox',checked:data.monetizationEnabled});
    const share=el('input',{type:'number',min:'0',max:'100',step:'0.01',value:data.creatorSharePercent==null?'':data.creatorSharePercent,placeholder:'0–100'});
    const form=el('form',{class:'console-form'},[
      field('Ads delivery',el('span',{class:'console-toggle'},[ads,el('span',{text:'Active campaign থাকলে public ad slot দেখাও'})]),'span-2'),
      field('Creator monetization',el('span',{class:'console-toggle'},[monet,el('span',{text:'Eligible channel-গুলোর estimated revenue হিসাব করো'})]),'span-2'),
      field('Creator share (%)',share),
      el('div',{class:'console-notice span-2',text:'Creator share এবং CPM কেবল estimate গণনা করে। এটি advertiser payment বা creator payout নিশ্চিত করে না। 0% share দিয়ে monetization enable করা যাবে না.'}),
      el('div',{class:'console-form-actions'},[el('button',{type:'submit',class:'primary-cta',text:'Settings save'})])
    ]);
    form.addEventListener('submit',async event=>{event.preventDefault();try{await ctx.jsonFetch('/api/admin/settings',{method:'PUT',body:{adsEnabled:ads.checked,monetizationEnabled:monet.checked,creatorSharePercent:share.value===''?null:Number(share.value)}});ctx.notify('Platform settings save হয়েছে।');await renderSettings(root,ctx);}catch(error){ctx.notify(error.message,'error');}});
    root.append(panel('Platform monetization settings','Ads default-off থাকে। Share percentage নিজের commercial policy অনুযায়ী নির্ধারণ করুন—এখানে কোনো default ভাগ ধরে নেওয়া হয়নি.',form));
  }

  window.ClipNestConsole={renderStudio,renderAdmin};
})();
