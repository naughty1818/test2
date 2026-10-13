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

  const pager = (page,pages,onChange) => {
    const wrap=el('div',{class:'console-pager','aria-label':'Pagination'});
    wrap.append(el('span',{text:`Page ${page} of ${Math.max(1,pages)}`}),button('Previous',()=>onChange(Math.max(1,page-1),'console-small-button'), 'console-small-button'),button('Next',()=>onChange(Math.min(Math.max(1,pages),page+1),'console-small-button'),'console-small-button'));
    wrap.querySelectorAll('button')[0].disabled=page<=1;wrap.querySelectorAll('button')[1].disabled=page>=pages;
    return wrap;
  };
  const asLocalDateTime = value => { if(!value)return ''; const d=new Date(value);d.setMinutes(d.getMinutes()-d.getTimezoneOffset());return d.toISOString().slice(0,16); };
  const statusBadge = value => { const labels={active:'Active',paused:'Paused',draft:'Draft',removed:'Removed',suspended:'Suspended',banned:'Banned',enabled:'Monetized',pending:'Pending',appealed:'Appealed',dismissed:'Dismissed',resolved:'Resolved',rejected:'Rejected'}; const kind=['active','enabled','resolved'].includes(value)?'good':['removed','banned','rejected'].includes(value)?'bad':['paused','suspended','pending','appealed'].includes(value)?'warn':''; return badge(labels[value]||value||'—',kind); };
  const safeAppealText = t => String(t||'').slice(0,2000);

  async function renderStudio(app,ctx) {
    app.replaceChildren(heading('CREATOR STUDIO','তোমার channel-এর পরিসংখ্যান','Views, engagement, subscriber growth এবং ad performance এক জায়গায় দেখো।'));
    const range=select([['7','৭ দিন'],['30','৩০ দিন'],['90','৯০ দিন']],'30');
    const rangeWrap=el('div',{class:'console-panel'},[el('div',{class:'console-form'},[field('সময়সীমা',range)])]); app.append(rangeWrap,el('div',{class:'console-grid'},[stat('পরিসরের views','…'),stat('মোট subscribers','…'),stat('মোট likes','…'),stat('ভিডিও', '…')]));
    const loading=panel('পরিসংখ্যান','তথ্য লোড হচ্ছে…',empty('একটু অপেক্ষা করো।')); app.append(loading);
    async function load() {
      try {
        const [data,learning]=await Promise.all([ctx.jsonFetch('/api/creator/analytics?days='+encodeURIComponent(range.value)),ctx.jsonFetch('/api/creator/learning-analytics?days='+encodeURIComponent(range.value)).catch(()=>({videos:[],watchSeconds:0}))]);
        const totals=data.totals||{}, ads=data.ads||{};
        const learningVideos=learning.videos||[],learningById=new Map(learningVideos.map(item=>[item.id,item]));
        const playSessions=learningVideos.reduce((sum,item)=>sum+(Number(item.sessions)||0),0);
        const avgCompletion=playSessions?learningVideos.reduce((sum,item)=>sum+(Number(item.averageCompletion)||0)*(Number(item.sessions)||0),0)/playSessions:0;
        app.replaceChildren(heading('CREATOR STUDIO','তোমার channel-এর পরিসংখ্যান','Views, engagement, subscriber growth এবং ad performance এক জায়গায় দেখো।'),rangeWrap,
          el('div',{class:'console-grid'},[stat('মোট views',num(totals.views),'নির্বাচিত সময়ের chart নিচে'),stat('Subscribers',num(totals.subscribers),'বর্তমান channel followers'),stat('মোট likes',num(totals.likes),'সব ভিডিও মিলিয়ে'),stat('ভিডিও',num(totals.videos),'আপলোড করা সব ভিডিও'),stat('Watch time',num(Math.round((Number(learning.watchSeconds)||0)/3600))+' ঘণ্টা','Best-effort sampled watch time'),stat('Play sessions',num(playSessions),'Pseudonymous; unique people নয়'),stat('গড় completion',Math.round(avgCompletion*100)+'%','Sampled retention')]));
        rangeWrap.querySelector('select').value=String(data.days||range.value);
        const points=(data.viewsByDay||[]).slice(-14); const max=Math.max(1,...points.map(x=>Number(x.views)||0));
        const chart=el('div',{class:'console-chart'});
        points.forEach(point=>{const bar=el('div',{class:'console-chart-bar',style:''});bar.style.height=Math.max(3,Math.round((Number(point.views)||0)/max*88))+'px';bar.title=num(point.views)+' views · '+point.day;bar.append(el('span',{text:String(point.day||'').slice(5)}));chart.append(bar);});
        if(!points.length) chart.append(empty('এখনো chart data নেই।'));
        app.append(panel('Views trend','শেষ '+num(data.days)+' দিনের recorded unique views',chart));
        const rows=(data.videos||[]).map(video=>{const metric=learningById.get(video.id)||{};return tr(cell(el('strong',{text:video.title}),el('div',{class:'console-muted',text:dateText(video.createdAt)})),cell(num(video.views)),cell(num(video.likes)),cell(num(video.comments)),cell(num(metric.watchSeconds)+' sec'),cell(num(metric.sessions)),cell(Math.round((Number(metric.averageCompletion)||0)*100)+'%'),cell(statusBadge(video.moderationStatus)),cell(money(video.estimatedEarningsBdt)));});
        app.append(panel('তোমার ভিডিও','Ad earnings estimate, watch time ও completion ইঙ্গিতমূলক—verified audience বা payout নয়.',rows.length?table(['ভিডিও','Views','Likes','Comments','Watch sec','Sessions','Completion','Status','আনুমানিক আয়'],rows):empty('এখনো কোনো ভিডিও নেই।')));
        if(learningVideos.length){
          const retentionVideo=select(learningVideos.map(item=>[item.id,item.title||item.id]),learningVideos[0].id),retentionChart=el('div',{class:'console-chart'}),retentionCaption=el('div',{class:'console-muted',text:'Retention data লোড হচ্ছে…'});
          async function loadRetention(){try{const info=await ctx.jsonFetch('/api/creator/learning-analytics?days='+encodeURIComponent(range.value)+'&videoId='+encodeURIComponent(retentionVideo.value));retentionCaption.textContent=num(info.sessions)+' sessions · '+num(info.watchSeconds)+' watch seconds · '+Math.round((Number(info.averageCompletion)||0)*100)+'% average completion';retentionChart.replaceChildren();const bars=info.retention||[],max=Math.max(1,...bars.map(x=>Number(x.rate)||0));bars.forEach(point=>{const bar=el('div',{class:'console-chart-bar'});bar.style.height=Math.max(2,Math.round((Number(point.rate)||0)/max*88))+'px';bar.title=point.percent+'% · '+point.rate+'% audience';bar.append(el('span',{text:String(point.percent)+'%'}));retentionChart.append(bar);});}catch(error){retentionCaption.textContent=error.message;}}
          retentionVideo.addEventListener('change',loadRetention);await loadRetention();
          app.append(panel('Audience retention','কত শতাংশ পর্যন্ত viewer sample পৌঁছেছে। Anonymous session-based estimate; unique মানুষ নয়.',el('div',{},[field('ভিডিও',retentionVideo),retentionCaption,retentionChart])));
        }
        await renderCreatorAssets(app,ctx,data.videos||[]);
        const statusText=data.monetizationStatus==='enabled'?'চ্যানেল monetization-এ অনুমোদিত।':data.monetizationStatus==='paused'?'Monetization বর্তমানে pause করা।':data.monetizationStatus==='rejected'?'Monetization অনুমোদিত হয়নি।':'Monetization approval-এর অপেক্ষায়।';
        const notice=el('div',{class:'console-notice',text:statusText+' Real payout ও payment method এখনো যুক্ত নয়।'});
        const summary=el('div',{class:'console-grid'},[stat('Ad impressions',num(ads.impressions)),stat('Ad clicks',num(ads.clicks)),stat('Estimated creator earnings',money(ads.estimatedEarningsBdt),'যাচাই করা payment নয়'),stat('Active copyright strikes',num(data.activeStrikes))]);
        app.append(panel('Monetization & ads','বর্তমান ad campaigns থেকে মাপা পরিসংখ্যান।',el('div',{},[notice,summary])));
        const strikeData=await ctx.jsonFetch('/api/creator/strikes').catch(()=>({strikes:[]}));
        const strikeRows=(strikeData.strikes||[]).map(item=>{
          const reason=el('div',{class:'console-muted',text:item.reason});
          const content=el('div',{},[el('strong',{text:item.videoTitle}),el('div',{class:'console-muted',text:dateText(item.createdAt)}),reason,item.appealText?el('div',{class:'console-muted',text:'আপিল: '+item.appealText}):null,item.resolutionNote?el('div',{class:'console-notice',text:'সিদ্ধান্ত: '+item.resolutionNote}):null]);
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

  async function renderCreatorAssets(root,ctx,videos){
    if(!videos.length)return;
    const chosen=select(videos.map(v=>[v.id,v.title||v.id]),videos[0].id);
    const chapterList=el('div',{class:'console-list'}),captionList=el('div',{class:'console-list'});
    const start=el('input',{type:'number',min:'0',step:'1',placeholder:'Seconds'}),chapterTitle=el('input',{type:'text',maxlength:'120',placeholder:'Chapter title'}),chapters=[];
    function renderChapters(){chapterList.replaceChildren();chapters.forEach((item,index)=>chapterList.append(el('div',{class:'console-list-row'},[el('span',{text:Math.floor(item.startSeconds/60)+':'+String(item.startSeconds%60).padStart(2,'0')+' · '+item.title}),button('Remove',()=>{chapters.splice(index,1);renderChapters();})])));if(!chapters.length)chapterList.append(empty('এখনো chapter নেই।'));}
    const addChapter=button('Chapter যোগ করো',()=>{const value=start.value===''?NaN:Number(start.value),title=chapterTitle.value.trim();if(!Number.isInteger(value)||value<0||!title){ctx.notify('Chapter time ও title দিন।','error');return;}chapters.push({startSeconds:value,title});chapters.sort((a,b)=>a.startSeconds-b.startSeconds);start.value='';chapterTitle.value='';renderChapters();});
    const saveChapters=button('Chapters save',async()=>{try{await ctx.jsonFetch('/api/videos/'+encodeURIComponent(chosen.value)+'/chapters',{method:'PUT',body:{chapters}});ctx.notify('Chapters save হয়েছে।');await loadAssets();}catch(error){ctx.notify(error.message,'error');}});
    const language=el('input',{type:'text',maxlength:'35',value:'bn',placeholder:'bn / en'}),label=el('input',{type:'text',maxlength:'80',value:'বাংলা',placeholder:'Caption label'}),captionFile=el('input',{type:'file',accept:'.vtt,text/vtt'}),isDefault=el('input',{type:'checkbox',checked:true});
    const captionForm=el('form',{class:'console-form'},[field('Language code',language),field('Track label',label),field('WEBVTT file (max 2 MB)',captionFile),field('Default track',isDefault),el('div',{class:'console-form-actions'},[el('button',{type:'submit',class:'primary-cta',text:'Caption upload / update'})])]);
    captionForm.addEventListener('submit',async event=>{event.preventDefault();const file=captionFile.files?.[0];if(!file)return ctx.notify('WEBVTT file বেছে নাও।','error');if(file.size>2*1024*1024)return ctx.notify('Caption file 2 MB-এর বেশি হতে পারবে না।','error');try{const response=await fetch('/api/videos/'+encodeURIComponent(chosen.value)+'/captions/'+encodeURIComponent(language.value.trim().toLowerCase())+'?label='+encodeURIComponent(label.value.trim())+'&default='+isDefault.checked,{method:'PUT',headers:{'Content-Type':'text/vtt'},body:await file.text()});if(!response.ok){const result=await response.json().catch(()=>({}));throw new Error(result.error||'Caption upload failed.');}ctx.notify('Caption track save হয়েছে।');captionFile.value='';await loadAssets();}catch(error){ctx.notify(error.message,'error');}});
    async function loadAssets(){try{const [chapterData,captionData]=await Promise.all([ctx.jsonFetch('/api/videos/'+encodeURIComponent(chosen.value)+'/chapters'),ctx.jsonFetch('/api/videos/'+encodeURIComponent(chosen.value)+'/captions')]);chapters.splice(0,chapters.length,...(chapterData.chapters||[]).map(x=>({startSeconds:Number(x.startSeconds),title:x.title})));renderChapters();captionList.replaceChildren();for(const item of captionData.captions||[])captionList.append(el('div',{class:'console-list-row'},[el('span',{text:item.label+' · '+item.language+(item.isDefault?' · Default':'')}),button('Delete',async()=>{try{await ctx.jsonFetch('/api/videos/'+encodeURIComponent(chosen.value)+'/captions/'+encodeURIComponent(item.language),{method:'DELETE'});await loadAssets();}catch(error){ctx.notify(error.message,'error');}})]));if(!captionList.childElementCount)captionList.append(empty('Caption track নেই।'));}catch(error){chapterList.replaceChildren(el('div',{class:'console-notice',text:error.message}));}}
    chosen.addEventListener('change',loadAssets);
    const editor=panel('Chapters & captions','Chapter-গুলোর time ক্রমানুসারে দিন। বাংলা ও English WebVTT caption creator-ই upload করে.',el('div',{},[field('ভিডিও',chosen),el('h3',{text:'Chapters'}),el('div',{class:'console-form'},[field('Start time (seconds)',start),field('Chapter title',chapterTitle),addChapter]),chapterList,saveChapters,el('h3',{text:'Caption tracks'}),captionList,captionForm]));
    root.append(editor);await loadAssets();
  }

  async function renderReviewQueue(root,ctx,initialType='all'){
    const role=ctx.adminRole,q=el('input',{type:'search',placeholder:'Title, creator, report reason…',value:''});
    const typeOptions=[['all','All pending'],['report','User reports']];
    if(['owner','admin'].includes(role))typeOptions.push(['video_appeal','Video appeals'],['strike_appeal','Copyright-strike appeals']);
    const type=select(typeOptions,initialType),reviewStatus=select([['all','All pending statuses'],['open','Open'],['reviewing','In review'],['pending','Appeal pending'],['appealed','Strike appealed']]),search=button('Apply filters',()=>{page=1;load();},'primary-cta'),list=el('div'),controls=el('div',{class:'console-form console-filter-bar'},[field('Review type',type),field('Status',reviewStatus),field('Search',q),el('div',{class:'console-form-actions'},[search])]);
    let page=1,pages=1;
    async function load(){list.replaceChildren(empty('Loading review queue…'));try{
      const data=await ctx.jsonFetch('/api/admin/review-queue?type='+encodeURIComponent(type.value)+'&status='+encodeURIComponent(reviewStatus.value)+'&q='+encodeURIComponent(q.value.trim())+'&page='+page+'&limit=20');pages=Math.max(1,data.pages||1);page=data.page||page;
      list.replaceChildren();
      if(!data.items?.length){list.append(empty('No pending reviews match these filters.'));return;}
      for(const item of data.items){
        const kindLabel={report:'User report',video_appeal:'Video removal appeal',strike_appeal:'Copyright-strike appeal'}[item.type]||item.type;
        const target=item.href?el('a',{href:item.href,'data-route':'',text:item.targetLabel||item.targetId}):el('strong',{text:item.targetLabel||item.targetId});
        const meta=el('div',{class:'review-card-meta'},[badge(kindLabel,'warn'),statusBadge(item.status),el('span',{text:dateText(item.createdAt)}),item.actorHandle?el('span',{text:'@'+item.actorHandle}):null]);
        const reasonText=item.type==='video_appeal'?'Video removal appeal':item.type==='strike_appeal'?'Copyright-strike appeal':item.reason;
        const detail=el('p',{class:'console-review-detail',text:item.details||reasonText||'No additional details'});
        const card=el('article',{class:'review-card'},[el('div',{class:'review-card-copy'},[meta,target,el('div',{class:'console-muted',text:item.reason||kindLabel}),detail])]);
        const actions=el('div',{class:'review-card-actions'});
        if(item.type==='report'){
          const note=el('textarea',{rows:'2',maxlength:'2000',placeholder:'Decision reason (at least 5 characters)'});
          const actOptions=[['none','Choose moderation action']];
          if(item.targetType==='video')actOptions.push(['remove_video','Remove video'],['restore_video','Restore video'],['copyright_strike','Copyright strike + remove']);
          if(item.targetType==='channel')actOptions.push(['suspend_channel','Suspend channel'],['ban_channel','Ban channel'],['unban_channel','Restore channel access']);
          const action=select(actOptions,'none'),evidence=el('input',{type:'url',placeholder:'Evidence URL (HTTPS, optional)'});
          evidence.hidden=true;action.addEventListener('change',()=>{evidence.hidden=action.value!=='copyright_strike';});
          const decide=async(status)=>{if(note.value.trim().length<5){ctx.notify('Write a decision reason (at least 5 characters).','error');note.focus();return;}if(status==='action_taken'&&action.value==='none'){ctx.notify('Choose a moderation action before closing this report.','error');action.focus();return;}try{await ctx.jsonFetch('/api/admin/reports/'+encodeURIComponent(item.id)+'/status',{method:'POST',body:{status,resolution:note.value.trim(),action:status==='action_taken'?action.value:'none',evidenceUrl:evidence.value||undefined}});ctx.notify(status==='action_taken'?'Action applied and report resolved.':'Report decision saved.');await load();}catch(error){ctx.notify(error.message,'error');}};
          actions.append(field('Moderation action',action),field('Reason',note));if(item.targetType==='video')actions.append(field('Evidence link',evidence));
          const reportButtons=[button('Start review',()=>decide('reviewing'))];
          if(item.targetType==='video'||item.targetType==='channel')reportButtons.push(button('Apply action & close',()=>decide('action_taken'),'primary-cta'));
          reportButtons.push(button('Dismiss',()=>decide('dismissed'),'console-small-button'));
          actions.append(el('div',{class:'console-form-actions'},reportButtons));
        }else if(item.type==='video_appeal'){
          const note=el('textarea',{rows:'2',maxlength:'1000',placeholder:'Decision reason (at least 5 characters)'});actions.append(field('Decision reason',note));
          const decide=async(decision)=>{if(note.value.trim().length<5){ctx.notify('Write a decision reason (at least 5 characters).','error');note.focus();return;}try{await ctx.jsonFetch('/api/admin/appeals/'+encodeURIComponent(item.id)+'/decision',{method:'POST',body:{decision,note:note.value.trim()}});ctx.notify(decision==='approved'?'Appeal approved; video restored.':'Appeal rejected.');await load();}catch(error){ctx.notify(error.message,'error');}};
          actions.append(el('div',{class:'console-form-actions'},[button('Approve & restore',()=>decide('approved'),'primary-cta'),button('Reject',()=>decide('rejected'),'console-small-button')]));
        }else if(item.type==='strike_appeal'){
          const note=el('textarea',{rows:'2',maxlength:'1000',placeholder:'Decision reason (at least 5 characters)'}),restore=el('input',{type:'checkbox',checked:true});
          actions.append(field('Decision reason',note),field('Restore video if appeal is accepted',el('span',{class:'console-toggle'},[restore,el('span',{text:'Restore the removed video'})])));
          const decide=async(decision)=>{if(note.value.trim().length<5){ctx.notify('Write a decision reason (at least 5 characters).','error');note.focus();return;}try{await ctx.jsonFetch('/api/admin/strikes/'+encodeURIComponent(item.id)+'/decision',{method:'POST',body:{decision,note:note.value.trim(),restoreVideo:decision==='dismissed'&&restore.checked}});ctx.notify(decision==='dismissed'?'Strike appeal accepted.':'Strike upheld.');await load();}catch(error){ctx.notify(error.message,'error');}};
          actions.append(el('div',{class:'console-form-actions'},[button('Accept appeal',()=>decide('dismissed'),'primary-cta'),button('Uphold strike',()=>decide('upheld'),'console-small-button')]));
        }
        card.append(actions);list.append(card);
      }
      list.append(pager(page,pages,next=>{page=next;load();}));
    }catch(error){list.replaceChildren(el('div',{class:'console-notice',text:error.message}));}}
    type.addEventListener('change',()=>{page=1;reviewStatus.value='all';load();});reviewStatus.addEventListener('change',()=>{page=1;load();});q.addEventListener('keydown',event=>{if(event.key==='Enter'){page=1;load();}});
    root.replaceChildren(panel('Review queue','One workspace for user reports and (for Admin/Owner) video and copyright-strike appeals.',el('div',{},[controls,list])));await load();
  }

  async function renderReports(root,ctx){return renderReviewQueue(root,ctx,'report');}
  async function renderAppeals(root,ctx){return renderReviewQueue(root,ctx,'video_appeal');}

  async function renderAdmin(app,ctx,chosenTab) {
    const queryTab=new URLSearchParams(location.search).get('tab'),role=ctx.adminRole;
    if(!role){app.replaceChildren(heading('ATHARO ADMIN','অনুমতি নেই','এই panel শুধু অনুমোদিত Admin/Moderator-এর জন্য।'));return;}
    const tabs=[['queue','Review queue'],['overview','Overview'],['moderation','Content & users'],['ads','Campaigns'],['audit','Audit log'],['staff','Staff & roles'],['settings','Platform settings']];
    let activeTab=chosenTab||queryTab||'queue';
    if((['ads','audit'].includes(activeTab)&&!['owner','admin'].includes(role))||(['staff','settings'].includes(activeTab)&&role!=='owner'))activeTab='queue';
    app.replaceChildren();app.classList.add('console-page','admin-shell');
    const toolbar=el('div',{class:'admin-toolbar'},[el('div',{class:'admin-brand'},[el('span',{class:'admin-mark',text:'A'}),el('div',{},[el('strong',{text:'Atharo Admin'}),el('span',{text:'Trust & Safety workspace'})])]),el('div',{class:'admin-toolbar-actions'},[badge(role==='owner'?'Owner':role==='admin'?'Admin':'Moderator','good'),el('a',{href:'/', 'data-route':'',class:'admin-return-link',text:'← Return to Atharo'}),button('Sign out',async()=>{try{await ctx.jsonFetch('/auth/logout',{method:'POST',body:{}});location.assign('/');}catch(error){ctx.notify(error.message,'error');}},'console-small-button')])]);
    const roleText=role==='moderator'?'You can triage reports and take moderation actions. Staff, platform settings, campaigns, audit logs and appeals are reserved for Admin/Owner.':role==='admin'?'You can manage campaigns, review reports and appeals, moderate content, and inspect the audit log. Owner controls staff access and platform-wide settings.':'Owner access: all admin, moderation, campaign and platform controls.';
    app.append(toolbar,heading('TRUST & SAFETY',role==='moderator'?'Moderator workspace':'Admin workspace',roleText));
    const nav=el('nav',{class:'console-tabs admin-tabs','aria-label':'Admin sections'});
    tabs.forEach(([id,label])=>{if(['ads','audit'].includes(id)&&!['owner','admin'].includes(role))return;if(['staff','settings'].includes(id)&&role!=='owner')return;nav.append(el('button',{type:'button',class:'console-tab'+(activeTab===id?' active':''),text:label,onClick:()=>ctx.navigate('/admin?tab='+id)}));});
    app.append(nav);
    const content=el('div',{class:'admin-tab-content'});app.append(content);
    try{
      if(activeTab==='queue')await renderReviewQueue(content,ctx,'all');
      else if(activeTab==='moderation')await renderModeration(content,ctx,role);
      else if(activeTab==='ads')await renderAds(content,ctx,role);
      else if(activeTab==='staff'&&role==='owner')await renderStaff(content,ctx);
      else if(activeTab==='settings'&&role==='owner')await renderSettings(content,ctx);
      else if(activeTab==='overview'){
        const [overview,audit]=await Promise.all([ctx.jsonFetch('/api/admin/overview'),ctx.jsonFetch('/api/admin/audit?limit=8&page=1').catch(()=>({events:[]}))]);
        const c=overview.counts||{},a=overview.ads||{},s=overview.settings||{};
        const quick=el('div',{class:'admin-quick-actions'},[button('Open review queue',()=>ctx.navigate('/admin?tab=queue'),'primary-cta'),button('Find content or users',()=>ctx.navigate('/admin?tab=moderation'),'console-small-button')]);
        const metrics=[stat('Pending reports',num(c.pendingReports),'Open + in review'),stat('Active accounts',num(c.activeAccounts),'Of '+num(c.users)+' total'),stat('Visible videos',num(c.videos)),stat('Open strikes',num(c.openStrikes)),stat('Suspended / banned',num(c.suspendedAccounts))];
        if(['owner','admin'].includes(role))metrics.push(stat('Video appeals',num(c.pendingVideoAppeals),'Awaiting Admin review'),stat('Strike appeals',num(c.pendingStrikeAppeals),'Awaiting Admin review'),stat('Active campaigns',num(c.activeCampaigns)));
        content.append(el('div',{class:'console-grid admin-metric-grid'},metrics),panel('Needs attention','Oldest pending reports and appeals are reviewed first in the queue.',quick));
        if(['owner','admin'].includes(role)){
          const range=select([['7','7 days'],['30','30 days'],['90','90 days']],'30'),chart=el('div',{class:'console-chart'}),summary=el('div',{class:'console-grid'},[stat('Ad impressions','…'),stat('Ad clicks','…'),stat('CTR','…'),stat('Estimated creator revenue','…','Estimate only; no payment system')]);
          const analyticsPanel=panel('Campaign performance','Recorded impressions/clicks by day. This is analytics only, not advertiser billing or creator payout.',el('div',{},[field('Date range',range),summary,chart]));content.append(analyticsPanel);
          const loadAnalytics=async()=>{try{const stats=await ctx.jsonFetch('/api/admin/ad-analytics?days='+range.value),t=stats.totals||{},n=Number(t.impressions)||0;summary.replaceChildren(stat('Ad impressions',num(t.impressions)),stat('Ad clicks',num(t.clicks)),stat('CTR',(n?(Number(t.clicks)||0)/n*100:0).toFixed(2)+'%'),stat('Estimated creator revenue',money(t.estimatedCreatorEarningsBdt),'Estimate only'));chart.replaceChildren();const points=(stats.daily||[]).slice(-14),max=Math.max(1,...points.map(x=>Number(x.impressions)||0));points.forEach(point=>{const bar=el('div',{class:'console-chart-bar'});bar.style.height=Math.max(3,Math.round((Number(point.impressions)||0)/max*88))+'px';bar.title=num(point.impressions)+' impressions · '+point.day;bar.append(el('span',{text:String(point.day).slice(5)}));chart.append(bar);});if(!points.length)chart.append(empty('No ad events in this date range.'));}catch(error){chart.replaceChildren(el('div',{class:'console-notice',text:error.message}));}};
          range.addEventListener('change',loadAnalytics);await loadAnalytics();
          content.append(panel('Platform controls','Advertising is off by default. Monetization metrics remain estimates; this repository has no payment or payout system.',el('div',{class:'console-grid'},[stat('Ad delivery',s.adsEnabled?'Enabled':'Off'),stat('Creator monetization',s.monetizationEnabled?'Enabled':'Off'),stat('Creator share',s.creatorSharePercent==null?'Not set':num(s.creatorSharePercent)+'%')])));
        }
        const rows=(audit.events||[]).map(x=>tr(cell(el('strong',{text:x.action}),el('div',{class:'console-muted',text:x.reason||'—'})),cell(x.actorEmail),cell(dateText(x.createdAt)),cell(x.targetType+': '+text(x.targetId))));
        content.append(panel('Recent admin actions','Every sensitive moderation and platform change is attributed and reasoned.',rows.length?table(['Action','Admin','Date','Target'],rows):empty('No admin actions recorded yet.')));
      }else if(activeTab==='audit'){
        let page=1,pages=1;const q=el('input',{type:'search',placeholder:'Search actor, action, target or reason'}),action=el('input',{type:'text',placeholder:'Exact action (optional)'}),from=el('input',{type:'date'}),to=el('input',{type:'date'}),list=el('div');
        const load=async()=>{list.replaceChildren(empty('Loading audit records…'));try{const params=new URLSearchParams({page:String(page),limit:'50',q:q.value.trim(),action:action.value.trim(),from:from.value,to:to.value});const data=await ctx.jsonFetch('/api/admin/audit?'+params);pages=Math.max(1,data.pages||1);page=data.page||page;const rows=(data.events||[]).map(x=>tr(cell(el('strong',{text:x.action}),el('div',{class:'console-muted',text:x.reason||'—'})),cell(x.actorEmail+' · '+x.actorRole),cell(dateText(x.createdAt)),cell(x.targetType+': '+text(x.targetId)),cell(JSON.stringify(x.metadata||{}).slice(0,180))));list.replaceChildren(rows.length?table(['Action','Actor','Date','Target','Details'],rows):empty('No audit entries match these filters.'),pager(page,pages,n=>{page=n;load();}));}catch(error){list.replaceChildren(el('div',{class:'console-notice',text:error.message}));}};
        const filters=el('div',{class:'console-form console-filter-bar'},[field('Search',q),field('Action',action),field('From',from),field('To',to),el('div',{class:'console-form-actions'},[button('Apply filters',()=>{page=1;load();},'primary-cta')])]);
        [q,action].forEach(x=>x.addEventListener('keydown',e=>{if(e.key==='Enter'){page=1;load();}}));[from,to].forEach(x=>x.addEventListener('change',()=>{page=1;load();}));content.append(panel('Audit log','Filter by actor, action, date range or target. Sensitive changes remain traceable.',el('div',{},[filters,list])));await load();
      }
    }catch(error){content.append(el('div',{class:'console-notice',text:error.message}));}
  }

  async function renderAds(root,ctx,role){
    root.replaceChildren();let campaignPage=1,campaignPages=1,editingId=null;
    const range=select([['7','7 days'],['30','30 days'],['90','90 days']],'30'),analytics=el('div',{class:'console-grid'},[stat('Impressions','…'),stat('Clicks','…'),stat('CTR','…'),stat('Estimated creator revenue','…','Estimate only')]),chart=el('div',{class:'console-chart'}),placementRows=el('div');
    const analyticsPanel=panel('Campaign performance','Performance is estimated from recorded events; this is not advertiser billing or creator payout.',el('div',{},[field('Date range',range),analytics,chart,placementRows]));root.append(analyticsPanel);
    async function loadAnalytics(){try{const data=await ctx.jsonFetch('/api/admin/ad-analytics?days='+range.value),t=data.totals||{},n=Number(t.impressions)||0;analytics.replaceChildren(stat('Impressions',num(t.impressions)),stat('Clicks',num(t.clicks)),stat('CTR',(n?(Number(t.clicks)||0)/n*100:0).toFixed(2)+'%'),stat('Estimated creator revenue',money(t.estimatedCreatorEarningsBdt),'Estimate only'));chart.replaceChildren();const points=(data.daily||[]).slice(-14),max=Math.max(1,...points.map(x=>Number(x.impressions)||0));points.forEach(point=>{const bar=el('div',{class:'console-chart-bar'});bar.style.height=Math.max(3,Math.round((Number(point.impressions)||0)/max*88))+'px';bar.title=num(point.impressions)+' impressions · '+num(point.clicks)+' clicks · '+point.day;bar.append(el('span',{text:String(point.day).slice(5)}));chart.append(bar);});if(!points.length)chart.append(empty('No event data in this range.'));const rows=(data.placements||[]).map(x=>tr(cell(x.placement),cell(num(x.impressions)),cell(num(x.clicks)),cell(x.ctr.toFixed(2)+'%')));placementRows.replaceChildren(rows.length?table(['Placement','Impressions','Clicks','CTR'],rows):empty('No placement data.'));}catch(error){chart.replaceChildren(el('div',{class:'console-notice',text:error.message}));}}
    range.addEventListener('change',loadAnalytics);await loadAnalytics();
    const campaignSearch=el('input',{type:'search',placeholder:'Campaign title or sponsor'}),campaignStatus=select([['all','All statuses'],['draft','Draft'],['active','Active'],['paused','Paused']]);
    const title=el('input',{type:'text',maxlength:'120',required:'',placeholder:'For example: Brand campaign'}),sponsor=el('input',{type:'text',maxlength:'120',required:'',placeholder:'Sponsor name'}),placement=select([['feed','Home feed native card · 16:9'],['watch_sidebar','Watch page sidebar · 4:3'],['channel','Creator channel sponsor · 16:9'],['sticky_banner','Sticky banner · 3:1'],['postroll','Post-roll sponsor · 16:9'],['l_banner','L-shape squeeze-back · 4:3']]),creative=el('input',{type:'url',required:'',placeholder:'HTTPS creative image URL'}),destination=el('input',{type:'url',required:'',placeholder:'HTTPS landing page URL'}),cpm=el('input',{type:'number',min:'0',max:'1000000',step:'0.01',value:'0',required:''}),starts=el('input',{type:'datetime-local'}),ends=el('input',{type:'datetime-local'}),previewImage=el('img',{alt:'Campaign creative preview',class:'campaign-preview-image'}),previewLink=el('a',{target:'_blank',rel:'noopener noreferrer',class:'campaign-preview-link',text:'Open landing page preview'}),preview=el('div',{class:'campaign-preview'},[previewImage,previewLink]);
    const syncPreview=()=>{previewImage.src=creative.value.trim();previewImage.hidden=!creative.value.trim();previewLink.href=destination.value.trim()||'#';previewLink.hidden=!destination.value.trim();preview.classList.toggle('campaign-preview-empty',!creative.value.trim());preview.dataset.placement=placement.value;};creative.addEventListener('input',syncPreview);destination.addEventListener('input',syncPreview);placement.addEventListener('change',syncPreview);
    const submit=el('button',{type:'submit',class:'primary-cta',text:'Create paused campaign'}),cancel=button('Cancel edit',()=>{editingId=null;form.reset();starts.value='';ends.value='';cpm.value='0';submit.textContent='Create paused campaign';cancel.hidden=true;syncPreview();},'console-small-button');cancel.hidden=true;
    const form=el('form',{class:'console-form'},[field('Campaign title',title),field('Sponsor',sponsor),field('Placement',placement),field('CPM (BDT / 1,000 impressions)',cpm),field('Creative image URL (HTTPS)',creative,'span-2'),field('Landing page URL (HTTPS)',destination,'span-2'),field('Start (optional)',starts),field('End (optional)',ends),field('Creative preview',preview,'span-2'),el('div',{class:'console-notice span-2',text:'Ads stay off unless an Owner enables delivery. Campaign creation starts paused. No advertiser billing or creator payout is implemented.'}),el('div',{class:'console-form-actions'},[submit,cancel])]);
    syncPreview();
    form.addEventListener('submit',async event=>{event.preventDefault();submit.disabled=true;const payload={title:title.value,sponsorName:sponsor.value,placement:placement.value,creativeUrl:creative.value,destinationUrl:destination.value,cpmBdt:Number(cpm.value),startsAt:starts.value?new Date(starts.value).toISOString():null,endsAt:ends.value?new Date(ends.value).toISOString():null};try{await ctx.jsonFetch(editingId?'/api/admin/campaigns/'+encodeURIComponent(editingId):'/api/admin/campaigns',{method:editingId?'PUT':'POST',body:payload});ctx.notify(editingId?'Campaign details saved.':'Campaign created in paused state.');editingId=null;form.reset();starts.value='';ends.value='';cpm.value='0';submit.textContent='Create paused campaign';cancel.hidden=true;syncPreview();await loadCampaigns();}catch(error){ctx.notify(error.message,'error');}finally{submit.disabled=false;}});
    root.append(panel('Campaign editor','Create paused campaigns, preview creative and landing URL, or edit campaign details.',form));
    const results=el('div');const loadCampaigns=async()=>{results.replaceChildren(empty('Loading campaigns…'));try{const params=new URLSearchParams({page:String(campaignPage),limit:'20',status:campaignStatus.value,q:campaignSearch.value.trim()});const data=await ctx.jsonFetch('/api/admin/campaigns?'+params);campaignPages=Math.max(1,data.pages||1);campaignPage=data.page||campaignPage;const rows=(data.campaigns||[]).map(c=>tr(cell(el('strong',{text:c.title}),el('div',{class:'console-muted',text:c.sponsorName+' · '+c.placement}),el('a',{href:c.destinationUrl,target:'_blank',rel:'noopener noreferrer',text:'Preview landing page'})),cell(statusBadge(c.status)),cell(num(c.impressions)),cell(num(c.clicks)),cell((c.impressions?(c.clicks/c.impressions*100):0).toFixed(2)+'%'),cell(money(c.cpmBdt)+' CPM'),cell(el('div',{class:'console-actions'},[button('Edit',()=>{editingId=c.id;title.value=c.title;sponsor.value=c.sponsorName;placement.value=c.placement;creative.value=c.creativeUrl;destination.value=c.destinationUrl;cpm.value=c.cpmBdt;starts.value=asLocalDateTime(c.startsAt);ends.value=asLocalDateTime(c.endsAt);submit.textContent='Save campaign changes';cancel.hidden=false;syncPreview();form.scrollIntoView({behavior:'smooth',block:'start'});},'console-small-button'),button(c.status==='active'?'Pause':'Activate',async()=>{try{await ctx.jsonFetch('/api/admin/campaigns/'+encodeURIComponent(c.id)+'/status',{method:'PATCH',body:{status:c.status==='active'?'paused':'active'}});ctx.notify('Campaign status updated.');await loadCampaigns();}catch(error){ctx.notify(error.message,'error');}})]))));results.replaceChildren(rows.length?table(['Campaign','Status','Impressions','Clicks','CTR','Rate','Actions'],rows):empty('No campaigns match these filters.'),pager(campaignPage,campaignPages,next=>{campaignPage=next;loadCampaigns();}));}catch(error){results.replaceChildren(el('div',{class:'console-notice',text:error.message}));}};
    const filters=el('div',{class:'console-form console-filter-bar'},[field('Search',campaignSearch),field('Status',campaignStatus),el('div',{class:'console-form-actions'},[button('Apply filters',()=>{campaignPage=1;loadCampaigns();},'primary-cta')])]);campaignSearch.addEventListener('keydown',e=>{if(e.key==='Enter'){campaignPage=1;loadCampaigns();}});campaignStatus.addEventListener('change',()=>{campaignPage=1;loadCampaigns();});root.append(panel('Campaign library','Filter and page through campaigns. CTR is clicks ÷ impressions; rates are not confirmed revenue.',el('div',{},[filters,results])));await loadCampaigns();
  }

  async function renderModeration(root,ctx,role) {
    const q=el('input',{type:'search',placeholder:'ভিডিও title, channel বা email খুঁজুন'}),status=select([['all','All statuses'],['active','Active'],['removed','Removed videos'],['suspended','Suspended accounts'],['banned','Banned accounts']]);
    const searchButton=el('button',{type:'button',class:'primary-cta',text:'Apply filters'});let page=1,pages=1;
    const searchBar=el('div',{class:'console-form console-filter-bar'},[field('Search',q),field('Status',status),el('div',{class:'console-form-actions'},[searchButton])]);
    root.append(panel('Content & channel search','Reversible takedowns, account restrictions and copyright actions. Search and status filters are paged.',searchBar));
    const targetPanel=el('div');root.append(targetPanel);
    async function loadContent() {
      try {
        const params=new URLSearchParams({q:q.value.trim(),status:status.value,page:String(page),limit:'50'});
        const data=await ctx.jsonFetch('/api/admin/content?'+params);
        const videoPages=Math.ceil((data.totals?.videos||0)/data.limit),channelPages=Math.ceil((data.totals?.channels||0)/data.limit),strikePages=Math.ceil((data.totals?.strikes||0)/data.limit);pages=Math.max(1,videoPages,channelPages,strikePages);
        page=data.page||page;targetPanel.replaceChildren(el('div',{class:'console-results-summary',text:`Page ${page} · ${num(data.totals?.videos||0)} matching videos · ${num(data.totals?.channels||0)} matching channels · ${num(data.totals?.strikes||0)} strikes`}));
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
        targetPanel.append(panel('Copyright strike records','Appealed copyright strikes can be decided in the Review queue.',strikeRows.length?table(['Notice','Status'],strikeRows):empty('No strike records on this page.')));
        targetPanel.append(pager(page,pages,next=>{page=next;loadContent();}));
      } catch(error) {targetPanel.replaceChildren(el('div',{class:'console-notice',text:error.message}));}
    }
    searchButton.addEventListener('click',()=>{page=1;loadContent();});status.addEventListener('change',()=>{page=1;loadContent();});q.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();page=1;loadContent();}});
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
    const toggles=data.adToggles||{};
    const adFeed=el('input',{type:'checkbox',checked:toggles.feed!==false});
    const adWatch=el('input',{type:'checkbox',checked:toggles.watchSidebar!==false});
    const adChannel=el('input',{type:'checkbox',checked:toggles.channel!==false});
    const adSticky=el('input',{type:'checkbox',checked:toggles.sticky===true});
    const adPostroll=el('input',{type:'checkbox',checked:toggles.postroll===true});
    const adLBanner=el('input',{type:'checkbox',checked:toggles.lBanner===true});
    const lBannerDuration=el('input',{type:'number',min:'3',max:'60',step:'1',value:data.lBannerDurationSeconds||10});
    const monet=el('input',{type:'checkbox',checked:data.monetizationEnabled});
    const share=el('input',{type:'number',min:'0',max:'100',step:'0.01',value:data.creatorSharePercent==null?'':data.creatorSharePercent,placeholder:'0–100'});
    const form=el('form',{class:'console-form'},[
      field('Ads delivery',el('span',{class:'console-toggle'},[ads,el('span',{text:'Active campaign থাকলে public ad slot দেখাও'})]),'span-2'),
      field('Feed ads',el('span',{class:'console-toggle'},[adFeed,el('span',{text:'Home native cards · 16:9'})])),field('Watch sidebar ads',el('span',{class:'console-toggle'},[adWatch,el('span',{text:'Desktop sidebar · 4:3'})])),field('Creator channel ads',el('span',{class:'console-toggle'},[adChannel,el('span',{text:'Channel sponsor · 16:9'})])),field('Sticky banner ads',el('span',{class:'console-toggle'},[adSticky,el('span',{text:'Reserved · 3:1'})])),field('Post-roll ads',el('span',{class:'console-toggle'},[adPostroll,el('span',{text:'Reserved · 16:9'})])),field('L-shape ads',el('span',{class:'console-toggle'},[adLBanner,el('span',{text:'Video squeeze-back · 4:3 image'})])),field('L-shape duration (seconds)',lBannerDuration),
      field('Creator monetization',el('span',{class:'console-toggle'},[monet,el('span',{text:'Eligible channel-গুলোর estimated revenue হিসাব করো'})]),'span-2'),
      field('Creator share (%)',share),
      el('div',{class:'console-notice span-2',text:'Creator share এবং CPM কেবল estimate গণনা করে। এটি advertiser payment বা creator payout নিশ্চিত করে না। 0% share দিয়ে monetization enable করা যাবে না.'}),
      el('div',{class:'console-form-actions'},[el('button',{type:'submit',class:'primary-cta',text:'Settings save'})])
    ]);
    form.addEventListener('submit',async event=>{event.preventDefault();try{await ctx.jsonFetch('/api/admin/settings',{method:'PUT',body:{adsEnabled:ads.checked,monetizationEnabled:monet.checked,creatorSharePercent:share.value===''?null:Number(share.value),adToggles:{feed:adFeed.checked,watchSidebar:adWatch.checked,channel:adChannel.checked,sticky:adSticky.checked,postroll:adPostroll.checked,lBanner:adLBanner.checked},lBannerDurationSeconds:Number(lBannerDuration.value)}});ctx.notify('Platform settings save হয়েছে।');await renderSettings(root,ctx);}catch(error){ctx.notify(error.message,'error');}});
    root.append(panel('Platform monetization settings','Ads default-off থাকে। Share percentage নিজের commercial policy অনুযায়ী নির্ধারণ করুন—এখানে কোনো default ভাগ ধরে নেওয়া হয়নি.',form));
  }

  window.AtharoConsole={renderStudio,renderAdmin,renderCreatorAssets};
})();
