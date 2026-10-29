'use strict';
(() => {
  const el = (tag, props = {}, children = []) => {
    const node = document.createElement(tag);
    for (const [key,value] of Object.entries(props || {})) {
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = window.AtharoI18n?.t(value == null ? '' : String(value)) ?? (value == null ? '' : String(value));
      else if (key === 'onClick') node.addEventListener('click',value);
      else if (key === 'value') node.value = value == null ? '' : String(value);
      else if (key === 'checked') node.checked = Boolean(value);
      else if (key === 'disabled') node.disabled = Boolean(value);
      else if (key === 'hidden') node.hidden = Boolean(value);
      else node.setAttribute(key,['placeholder','title','aria-label'].includes(key)?(window.AtharoI18n?.t(value)??value):value);
    }
    for (const child of children || []) if (child) node.append(child);
    return node;
  };
  const text = (v,fallback='—') => v === null || v === undefined || v === '' ? fallback : String(v);
  const num = v => (Number(v)||0).toLocaleString(window.AtharoI18n?.locale==='en'?'en-US':'bn-BD');
  const dateText = value => { if(!value) return '—'; try { return new Intl.DateTimeFormat(window.AtharoI18n?.locale==='en'?'en-US':'bn-BD',{dateStyle:'medium'}).format(new Date(value)); } catch(_) { return String(value); } };
  const money = value => { try { return new Intl.NumberFormat(window.AtharoI18n?.locale==='en'?'en-US':'bn-BD',{style:'currency',currency:'BDT',maximumFractionDigits:2}).format(Number(value)||0); } catch(_) { return '৳'+num(value); } };
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
    if(['owner','admin','custom'].includes(role))typeOptions.push(['video_appeal','Video appeals'],['strike_appeal','Copyright-strike appeals']);
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

  async function renderChannelApplications(root,ctx){
    const status=select([['pending','Pending'],['all','All applications'],['approved','Approved'],['rejected','Rejected']],'pending'),list=el('div');
    async function load(){list.replaceChildren(empty('Loading channel applications…'));try{const data=await ctx.jsonFetch('/api/admin/channel-applications?status='+encodeURIComponent(status.value));list.replaceChildren();const items=data.applications||[];if(!items.length){list.append(empty('No channel applications in this view.'));return;}for(const item of items){const card=el('article',{class:'review-card channel-application-card'}),top=el('div',{class:'review-card-copy'},[el('div',{class:'review-card-meta'},[badge(item.channelType,'warn'),badge((item.creatorType||'normal')+' creator','good'),statusBadge(item.status),el('span',{text:dateText(item.createdAt)})]),el('h3',{text:item.channelName}),el('div',{class:'console-muted',text:(item.name||'Google account')+' · '+item.email}),item.otherPlatformName?el('p',{text:'Other platform: '+item.otherPlatformName}):el('p',{class:'console-muted',text:'No other platform channel provided.'}),item.otherPlatformUrl?el('a',{href:item.otherPlatformUrl,target:'_blank',rel:'noopener noreferrer',text:'Open platform link ↗'}):null,item.decisionNote?el('p',{class:'console-notice',text:'Previous decision: '+item.decisionNote}):null]);card.append(top);if(item.status==='pending'){const note=el('textarea',{rows:'2',maxlength:'2000',placeholder:'Decision note (at least 5 characters)'}),actions=el('div',{class:'console-form-actions'});const decide=async decision=>{if(note.value.trim().length<5){ctx.notify('Write a decision note of at least 5 characters.','error');note.focus();return;}try{const result=await ctx.jsonFetch('/api/admin/channel-applications/'+encodeURIComponent(item.id)+'/decision',{method:'POST',body:{decision,note:note.value.trim()}});ctx.notify(decision==='approved'?'Channel approved. The applicant can now upload.':'Application rejected with a note.');await load();}catch(error){ctx.notify(error.message,'error');}};actions.append(button('Approve channel',()=>decide('approved'),'primary-cta'),button('Reject',()=>decide('rejected'),'console-small-button'));card.append(el('div',{class:'review-card-actions'},[field('Decision note',note),actions]));}list.append(card);}}
      catch(error){list.replaceChildren(el('div',{class:'console-notice',text:error.message}));}}
    status.addEventListener('change',load);root.replaceChildren(panel('Channel applications','Review the requested channel name, channel type, and existing platform presence. Approval creates the creator channel and unlocks upload access.',el('div',{},[el('div',{class:'studio-toolbar'},[field('Status',status)]),list])));await load();
  }
  async function renderShopApplications(root,ctx){
    const status=select([['pending','Pending'],['all','All applications'],['approved','Approved'],['rejected','Rejected']],'pending'),list=el('div');
    async function load(){list.replaceChildren(empty('Loading Shop applications…'));try{const data=await ctx.jsonFetch('/api/admin/shop-applications?status='+encodeURIComponent(status.value));list.replaceChildren();const items=data.applications||[];if(!items.length){list.append(empty('No Shop applications in this view.'));return;}for(const item of items){const card=el('article',{class:'review-card shop-application-card'}),copy=el('div',{class:'review-card-copy'},[el('div',{class:'review-card-meta'},[badge(item.businessType||'business','warn'),statusBadge(item.status),el('span',{text:dateText(item.createdAt)})]),el('h3',{text:item.businessName}),el('div',{class:'console-muted',text:(item.fullName||item.name||'Applicant')+' · '+(item.email||'')+' · '+(item.phone||'')}),el('p',{text:'পণ্য: '+item.productTypes}),el('p',{text:item.description}),el('p',{class:'console-muted',text:'ঠিকানা: '+item.address}),item.socialUrl?el('a',{href:item.socialUrl,target:'_blank',rel:'noopener noreferrer',text:'Open business link ↗'}):null,item.shopSlug?el('p',{class:'console-notice',text:'Approved Shop: /shop/'+item.shopSlug}):null,item.decisionNote?el('p',{class:'console-notice',text:'Previous decision: '+item.decisionNote}):null]);card.append(copy);if(item.status==='pending'){const note=el('textarea',{rows:'2',maxlength:'2000',placeholder:'Decision note (at least 5 characters)'}),actions=el('div',{class:'console-form-actions'});const decide=async decision=>{if(note.value.trim().length<5){ctx.notify('Write a decision note of at least 5 characters.','error');note.focus();return;}try{await ctx.jsonFetch('/api/admin/shop-applications/'+encodeURIComponent(item.id)+'/decision',{method:'POST',body:{decision,note:note.value.trim()}});ctx.notify(decision==='approved'?'Shop approved. Product publishing may now be enabled.':'Shop application rejected with a note.');await load();}catch(error){ctx.notify(error.message,'error');}};actions.append(button('Approve Shop',()=>decide('approved'),'primary-cta'),button('Reject',()=>decide('rejected'),'console-small-button'));card.append(el('div',{class:'review-card-actions'},[field('Decision note',note),actions]));}list.append(card);}}
      catch(error){list.replaceChildren(el('div',{class:'console-notice',text:error.message}));}}
    status.addEventListener('change',load);root.replaceChildren(panel('Shop applications','Only Admin/Owner approval creates an active Shop. Review the seller identity, business details and intended product category before approving.',el('div',{},[el('div',{class:'studio-toolbar'},[field('Status',status)]),list])));await load();
  }
  async function renderShopProducts(root,ctx){
    const status=select([['pending_review','Pending review'],['all','All products'],['approved','Approved'],['rejected','Rejected'],['hidden','Hidden'],['out_of_stock','Out of stock']],'pending_review'),list=el('div');
    async function load(){list.replaceChildren(empty('Loading Shop products…'));try{const data=await ctx.jsonFetch('/api/admin/shop-products?status='+encodeURIComponent(status.value));list.replaceChildren();const items=data.products||[];if(!items.length){list.append(empty('No Shop products in this view.'));return;}for(const item of items){const card=el('article',{class:'review-card'},[el('div',{class:'review-card-copy'},[el('div',{class:'review-card-meta'},[badge(item.category,'warn'),statusBadge(item.status),el('span',{text:dateText(item.createdAt)})]),el('h3',{text:item.name}),el('div',{class:'console-muted',text:(item.businessName||'Shop')+' · '+(item.ownerName||'')+' · '+(item.email||'')}),el('p',{text:'৳ '+money(item.priceBdt)+' · stock '+number(item.stockQuantity)}),el('p',{text:item.description}),el('p',{text:'ভালো দিক: '+(item.goodPoints||'—')}),el('p',{text:'সীমাবদ্ধতা: '+(item.limitations||'—')}),item.videoId?el('p',{class:'console-notice',text:'Product video attached: '+item.videoId}):el('p',{class:'console-muted',text:'No product video attached.'}),item.decisionNote?el('p',{class:'console-notice',text:'Previous decision: '+item.decisionNote}):null])]);if(item.status==='pending_review'||item.status==='approved'){const note=el('textarea',{rows:'2',maxlength:'2000',placeholder:'Decision note (at least 5 characters)'}),actions=el('div',{class:'console-form-actions'});const decide=async decision=>{if(note.value.trim().length<5){ctx.notify('Write a decision note of at least 5 characters.','error');note.focus();return;}try{await ctx.jsonFetch('/api/admin/shop-products/'+encodeURIComponent(item.id)+'/decision',{method:'POST',body:{decision,note:note.value.trim()}});ctx.notify('Product moderation decision saved.');await load();}catch(error){ctx.notify(error.message,'error');}};actions.append(button('Approve',()=>decide('approved'),'primary-cta'),button(item.status==='approved'?'Hide':'Reject',()=>decide(item.status==='approved'?'hidden':'rejected'),'console-small-button'));card.append(el('div',{class:'review-card-actions'},[field('Decision note',note),actions]));}list.append(card);}}
      catch(error){list.replaceChildren(el('div',{class:'console-notice',text:error.message}));}}
    status.addEventListener('change',load);root.replaceChildren(panel('Shop product moderation','Every new product is pending review. Only approved products appear in the public Shop catalogue.',el('div',{},[el('div',{class:'studio-toolbar'},[field('Status',status)]),list])));await load();
  }
  async function renderIslamicReview(root,ctx){
    const status=select([['pending','Pending'],['all','All Islamic videos'],['approved','Approved'],['rejected','Rejected']],'pending'),list=el('div');
    async function load(){list.replaceChildren(empty('Loading Islamic certification reviews…'));try{const data=await ctx.jsonFetch('/api/admin/islamic-review?status='+encodeURIComponent(status.value));list.replaceChildren();const items=data.videos||[];if(!items.length){list.append(empty('No Islamic video reviews in this view.'));return;}for(const item of items){const card=el('article',{class:'review-card'}),copy=el('div',{class:'review-card-copy'},[el('div',{class:'review-card-meta'},[badge('@'+(item.handle||'creator'),'warn'),statusBadge(item.status),el('span',{text:dateText(item.createdAt)})]),el('h3',{text:item.title}),el('div',{class:'console-muted',text:(item.creatorName||'Creator')+' · '+(item.email||'')+' · video '+item.id}),el('p',{text:item.description||'No description provided.'}),button('Preview source video',async()=>{const previewWindow=window.open('about:blank','_blank');if(previewWindow)previewWindow.opener=null;try{const preview=await ctx.jsonFetch('/api/admin/islamic-review/'+encodeURIComponent(item.id)+'/preview');if(previewWindow)previewWindow.location=preview.url;else ctx.notify('Allow pop-ups to open the admin preview.','error');}catch(error){if(previewWindow)previewWindow.close();ctx.notify(error.message,'error');}},'console-small-button'),item.reviewNote?el('p',{class:'console-notice',text:'Previous review: '+item.reviewNote}):null]);card.append(copy);if(item.status==='pending'){const note=el('textarea',{rows:'3',maxlength:'2000',placeholder:'Review note (at least 5 characters)'}),actions=el('div',{class:'console-form-actions'});const decide=async decision=>{if(note.value.trim().length<5){ctx.notify('Write a review note of at least 5 characters.','error');note.focus();return;}try{await ctx.jsonFetch('/api/admin/islamic-review/'+encodeURIComponent(item.id)+'/decision',{method:'POST',body:{decision,note:note.value.trim()}});ctx.notify(decision==='approved'?'Islamic video certified and enabled for Islamic mode.':'Islamic certification rejected.');await load();}catch(error){ctx.notify(error.message,'error');}};actions.append(button('Approve certification',()=>decide('approved'),'primary-cta'),button('Reject certification',()=>decide('rejected'),'console-small-button'));card.append(el('div',{class:'review-card-actions'},[field('Review note',note),actions]));}list.append(card);}}
    catch(error){list.replaceChildren(el('div',{class:'console-notice',text:error.message}));}}
    status.addEventListener('change',load);root.replaceChildren(panel('Islamic video certification','Creators can mark a video Islamic, but only an Admin/Moderator approval makes it eligible for Islamic-mode viewers.',el('div',{},[el('div',{class:'studio-toolbar'},[field('Status',status)]),list])));await load();
  }
  async function renderVerificationRequests(root,ctx){
    const status=select([['pending','Pending'],['all','All requests'],['approved','Approved'],['rejected','Rejected']],'pending'),list=el('div');
    async function load(){list.replaceChildren(empty('Loading verification requests…'));try{const data=await ctx.jsonFetch('/api/admin/verification-requests?status='+encodeURIComponent(status.value));list.replaceChildren();const items=data.requests||[];if(!items.length){list.append(empty('No verification requests in this view.'));return;}for(const item of items){const card=el('article',{class:'review-card'}),copy=el('div',{class:'review-card-copy'},[el('div',{class:'review-card-meta'},[badge('@'+item.handle,'good'),statusBadge(item.status),el('span',{text:dateText(item.createdAt)})]),el('h3',{text:item.displayName||item.handle}),el('div',{class:'console-muted',text:item.email}),el('p',{text:item.reason}),item.proofUrl?el('a',{href:item.proofUrl,target:'_blank',rel:'noopener noreferrer',text:'Open proof link ↗'}):el('span',{class:'console-muted',text:'No proof link'}),item.decisionNote?el('p',{class:'console-notice',text:'Previous decision: '+item.decisionNote}):null]);card.append(copy);if(item.status==='pending'){const note=el('textarea',{rows:'2',maxlength:'2000',placeholder:'Decision note (at least 5 characters)'}),actions=el('div',{class:'console-form-actions'});const decide=async decision=>{if(note.value.trim().length<5){ctx.notify('Write a decision note of at least 5 characters.','error');note.focus();return;}try{await ctx.jsonFetch('/api/admin/verification-requests/'+encodeURIComponent(item.id)+'/decision',{method:'POST',body:{decision,note:note.value.trim()}});ctx.notify(decision==='approved'?'Channel verified.':'Verification request rejected.');await load();}catch(error){ctx.notify(error.message,'error');}};actions.append(button('Approve verification',()=>decide('approved'),'primary-cta'),button('Reject',()=>decide('rejected'),'console-small-button'));card.append(el('div',{class:'review-card-actions'},[field('Decision note',note),actions]));}list.append(card);}}
      catch(error){list.replaceChildren(el('div',{class:'console-notice',text:error.message}));}}
    status.addEventListener('change',load);root.replaceChildren(panel('Creator verification','Approve verified creators here. Approved channels receive the green verification badge beside their name.',el('div',{},[el('div',{class:'studio-toolbar'},[field('Status',status)]),list])));await load();
  }

  async function renderSmsPayments(root,ctx){
    const summary=el('div',{class:'console-grid'}),list=el('div',{class:'studio-notification-list'}),claims=el('div',{class:'studio-notification-list'});
    async function load(){try{const [s,t,c]=await Promise.all([ctx.jsonFetch('/api/admin/sms-payments/summary'),ctx.jsonFetch('/api/admin/sms-payments/transactions?page=1&limit=50'),ctx.jsonFetch('/api/admin/sms-payments/claims')]);summary.replaceChildren(stat('আজকের SMS',num((s.today||[]).reduce((n,x)=>n+Number(x.count||0),0)),s.stale?'ফোন sync বন্ধ থাকতে পারে':'Sync সচল'),stat('Pending claims',num(s.pendingClaims)),stat('Last sync',s.lastSyncMinutes==null?'—':num(s.lastSyncMinutes)+' মিনিট আগে'));list.replaceChildren(...(t.transactions||[]).map(x=>el('div',{class:'studio-notification'},[el('span',{text:x.provider+' · '+x.sender_phone+' · TrxID শেষ '+String(x.trx_id).slice(-4)}),el('strong',{text:'৳ '+num(x.amount_bdt)+' · '+x.status})])));claims.replaceChildren(...(c.claims||[]).map(x=>el('div',{class:'studio-notification'},[el('span',{text:x.order_kind+' · '+String(x.trx_id).slice(-4)+' · '+x.phone}),el('strong',{text:'৳ '+num(x.amount_bdt)+' · '+num(x.attempts)+' বার'})])));}catch(e){summary.replaceChildren(el('div',{class:'console-notice',text:e.message}));}}
    root.replaceChildren(panel('SMS Payments','SMS Forwarder sync, unused/used transactions এবং pending claims দেখুন।',summary),panel('সিঙ্ক হওয়া SMS','শেষ ৫০টি transaction',list),panel('অপেক্ষমাণ আবেদন','ইউজারের TrxID যেগুলো এখনো মেলেনি',claims));await load();window.setTimeout(()=>{if(document.body.contains(root))load();},30000);
  }
  async function renderAdmin(app,ctx,chosenTab) {
    const queryTab=new URLSearchParams(location.search).get('tab'),role=ctx.adminRole,permissions=ctx.adminPermissions||[];
    const canModule=module=>role==='owner'||role==='admin'||(role==='moderator'&&['reports','islamic','content'].includes(module))||(role==='custom'&&(permissions.includes(module)||permissions.includes('*')||(module==='withdrawals:view'&&permissions.includes('withdrawals:manage'))));
    if(!role){app.replaceChildren(heading('ATHARO ADMIN','অনুমতি নেই','এই panel শুধু অনুমোদিত Admin/Moderator-এর জন্য।'));return;}
    const tabs=[['queue','Review queue'],['islamic-review','Islamic certification'],['applications','Channel applications'],['shop-applications','Shop applications'],['shop-products','Shop products'],['verification','Creator verification'],['overview','Overview'],['moderation','Content & users'],['withdrawals','Creator withdrawals'],['payments','SMS Payments'],['ads','Campaigns'],['audit','Audit log'],['staff','Staff & roles'],['settings','Platform settings']];
    let activeTab=chosenTab||queryTab||'queue';
    const tabPermission={overview:'overview',queue:'reports','islamic-review':'islamic',applications:'creators','shop-applications':'creators','shop-products':'creators',verification:'creators',moderation:'content',withdrawals:'withdrawals:view',payments:'payments',ads:'campaigns',audit:'audit',settings:'settings'};
    const tabAllowed=id=>id==='staff'?role==='owner':id==='overview'?role!=='custom'||permissions.length>0:(role==='custom'?canModule(tabPermission[id]):(['ads','audit','applications','shop-applications','shop-products','verification','withdrawals'].includes(id)?['owner','admin'].includes(role):(['staff','settings'].includes(id)?role==='owner':true)));
    if(!tabAllowed(activeTab))activeTab=role==='custom'?(['overview','withdrawals','queue','islamic-review','moderation','applications','ads','audit','settings'].find(tabAllowed)||'overview'):'queue';
    app.replaceChildren();app.classList.add('console-page','admin-shell');
    const toolbar=el('div',{class:'admin-toolbar'},[el('div',{class:'admin-brand'},[el('a',{href:'/', 'data-route':'',class:'brand-lockup', 'aria-label':'Atharo | আঠারো হোম'},[el('span',{class:'brand-latin',text:'Atharo |'}),el('img',{class:'brand-logo',src:'/assets/atharo-logo.png',alt:'Atharo | আঠারো'})]),el('div',{class:'admin-workspace-label'},[el('strong',{text:'Admin panel'}),el('span',{text:'Trust & Safety workspace'})])]),el('div',{class:'admin-toolbar-actions'},[window.AtharoI18n?.createSelector(),badge(role==='owner'?'Owner':role==='admin'?'Admin':role==='custom'?'Staff':'Moderator','good'),el('a',{href:'/', 'data-route':'',class:'admin-return-link',text:'← Return to Atharo'}),button('Sign out',async()=>{try{await ctx.jsonFetch('/auth/logout',{method:'POST',body:{}});location.assign('/');}catch(error){ctx.notify(error.message,'error');}},'console-small-button')])]);
    const roleText=role==='custom'?'Your workspace shows only the duties assigned by the Owner.':role==='moderator'?'You can triage reports, take moderation actions, and review Islamic video certification. Staff, platform settings, campaigns, audit logs and appeals are reserved for Admin/Owner.':role==='admin'?'You can manage campaigns, review reports and appeals, moderate content, and inspect the audit log. Owner controls staff access and platform-wide settings.':'Owner access: all admin, moderation, campaign and platform controls.';
    app.append(toolbar,heading('TRUST & SAFETY',role==='moderator'?'Moderator workspace':'Admin workspace',roleText));
    const nav=el('nav',{class:'console-tabs admin-tabs','aria-label':'Admin sections'});
    const groups=[['WORKSPACE',[['overview','Overview']]],['REVIEW & SAFETY',[['queue','Reports & appeals'],['islamic-review','Islamic certification']]],['CREATORS & COMMUNITY',[['applications','Channel applications'],['shop-applications','Shop applications'],['shop-products','Shop products'],['verification','Creator verification']]],['MANAGE',[['moderation','Content & users']]],['MONEY & CAMPAIGNS',[['withdrawals','Creator withdrawals'],['payments','SMS Payments'],['ads','Campaigns']]],['SYSTEM',[['audit','Audit log'],['staff','Staff & roles'],['settings','Platform settings']]]];
    groups.forEach(([groupLabel,items])=>{const visible=items.filter(([id])=>tabAllowed(id));if(!visible.length)return;const section=el('div',{class:'admin-nav-group'},[el('span',{class:'admin-nav-label',text:groupLabel})]);visible.forEach(([id,label])=>section.append(el('button',{type:'button',class:'console-tab'+(activeTab===id?' active':''),text:label,onClick:()=>ctx.navigate('/admin?tab='+id)})));nav.append(section);});
    app.append(nav);
    const content=el('div',{class:'admin-tab-content'});app.append(content);
    if(window.__atharoAdminRefreshHandler)window.removeEventListener('atharo:admin-refresh',window.__atharoAdminRefreshHandler);
    window.__atharoAdminRefreshHandler=event=>{const tab={reports:'queue',withdrawals:'withdrawals',islamic:'islamic-review'}[event.detail?.module];if(activeTab!=='overview'&&activeTab!==tab)return;window.clearTimeout(window.__atharoAdminRefreshTimer);window.__atharoAdminRefreshTimer=window.setTimeout(()=>ctx.navigate('/admin?tab='+activeTab),300);};
    window.addEventListener('atharo:admin-refresh',window.__atharoAdminRefreshHandler);
    try{
      if(activeTab==='queue')await renderReviewQueue(content,ctx,'all');
      else if(activeTab==='islamic-review')await renderIslamicReview(content,ctx);
      else if(activeTab==='applications'&&(['owner','admin'].includes(role)||canModule('creators')))await renderChannelApplications(content,ctx);
      else if(activeTab==='shop-applications'&&(['owner','admin'].includes(role)||canModule('creators')))await renderShopApplications(content,ctx);
      else if(activeTab==='shop-products'&&(['owner','admin'].includes(role)||canModule('creators')))await renderShopProducts(content,ctx);
      else if(activeTab==='verification'&&(['owner','admin'].includes(role)||canModule('creators')))await renderVerificationRequests(content,ctx);
      else if(activeTab==='moderation')await renderModeration(content,ctx,role);
      else if(activeTab==='ads')await renderAds(content,ctx,role);
      else if(activeTab==='staff'&&role==='owner')await renderStaff(content,ctx);
      else if(activeTab==='settings'&&(role==='owner'||canModule('settings')))await renderSettings(content,ctx);
      else if(activeTab==='withdrawals'&&(['owner','admin'].includes(role)||canModule('withdrawals:view')))await renderWithdrawals(content,{...ctx,adminRole:role,adminPermissions:permissions});
      else if(activeTab==='payments'&&canModule('payments'))await renderSmsPayments(content,ctx);
      else if(activeTab==='overview'){
        const [overview,audit,islamic,withdrawals]=await Promise.all([ctx.jsonFetch('/api/admin/overview'),ctx.jsonFetch('/api/admin/audit?limit=8&page=1').catch(()=>({events:[]})),canModule('islamic')?ctx.jsonFetch('/api/admin/islamic-review?status=pending').catch(()=>({videos:[]})):Promise.resolve({videos:[]}),canModule('withdrawals:view')?ctx.jsonFetch('/api/admin/creator-withdrawals?status=pending').catch(()=>({withdrawals:[]})):Promise.resolve({withdrawals:[]})]);
        const c=overview.counts||{},a=overview.ads||{},s=overview.settings||{};
        const quick=el('div',{class:'admin-quick-actions'},[canModule('reports')?button('Open review queue',()=>ctx.navigate('/admin?tab=queue'),'primary-cta'):null,canModule('content')?button('Find content or users',()=>ctx.navigate('/admin?tab=moderation'),'console-small-button'):null]);
        const metrics=[];if(canModule('reports'))metrics.push(stat('Pending reports',num(c.pendingReports),'Open + in review'));if(canModule('content'))metrics.push(stat('Active accounts',num(c.activeAccounts),'Of '+num(c.users)+' total'),stat('Visible videos',num(c.videos)),stat('Open strikes',num(c.openStrikes)),stat('Suspended / banned',num(c.suspendedAccounts)));
        if(['owner','admin'].includes(role))metrics.push(stat('Video appeals',num(c.pendingVideoAppeals),'Awaiting Admin review'),stat('Strike appeals',num(c.pendingStrikeAppeals),'Awaiting Admin review'),stat('Active campaigns',num(c.activeCampaigns)));
        content.append(el('div',{class:'console-grid admin-metric-grid'},metrics));
        const attention=el('div',{class:'admin-attention-list'}),tasks=[];
        if(canModule('reports'))tasks.push(['User reports',Number(c.pendingReports)||0,'Oldest reports first','queue'],['Video & strike appeals',(Number(c.pendingVideoAppeals)||0)+(Number(c.pendingStrikeAppeals)||0),'Awaiting Admin review','queue']);
        if(canModule('islamic'))tasks.push(['Islamic certification',(islamic.videos||[]).length,'Creator-marked videos awaiting review','islamic-review']);
        if(canModule('withdrawals:view'))tasks.push(['Creator withdrawals',(withdrawals.withdrawals||[]).length,'Pending payout requests','withdrawals']);
        tasks.forEach(([label,count,note,tab])=>{const row=el('div',{class:'admin-attention-row'},[el('div',{class:'admin-attention-copy'},[el('strong',{text:label}),el('span',{text:note})]),el('span',{class:'admin-attention-count',text:num(count)}),button('Review now',()=>ctx.navigate('/admin?tab='+tab),count?'primary-cta':'console-small-button')]);attention.append(row);});
        content.append(panel('Needs attention','Pending tasks are grouped here so you can jump straight to the right queue.',attention),panel('Quick actions','',quick));
        if(canModule('campaigns')){
          const range=select([['7','7 days'],['30','30 days'],['90','90 days']],'30'),chart=el('div',{class:'console-chart'}),summary=el('div',{class:'console-grid'},[stat('Ad impressions','…'),stat('Ad clicks','…'),stat('CTR','…'),stat('Estimated creator revenue','…','Estimate only; no payment system')]);
          const analyticsPanel=panel('Campaign performance','Recorded impressions/clicks by day. This is analytics only, not advertiser billing or creator payout.',el('div',{},[field('Date range',range),summary,chart]));content.append(analyticsPanel);
          const loadAnalytics=async()=>{try{const stats=await ctx.jsonFetch('/api/admin/ad-analytics?days='+range.value),t=stats.totals||{},n=Number(t.impressions)||0;summary.replaceChildren(stat('Ad impressions',num(t.impressions)),stat('Ad clicks',num(t.clicks)),stat('CTR',(n?(Number(t.clicks)||0)/n*100:0).toFixed(2)+'%'),stat('Estimated creator revenue',money(t.estimatedCreatorEarningsBdt),'Estimate only'));chart.replaceChildren();const points=(stats.daily||[]).slice(-14),max=Math.max(1,...points.map(x=>Number(x.impressions)||0));points.forEach(point=>{const bar=el('div',{class:'console-chart-bar'});bar.style.height=Math.max(3,Math.round((Number(point.impressions)||0)/max*88))+'px';bar.title=num(point.impressions)+' impressions · '+point.day;bar.append(el('span',{text:String(point.day).slice(5)}));chart.append(bar);});if(!points.length)chart.append(empty('No ad events in this date range.'));}catch(error){chart.replaceChildren(el('div',{class:'console-notice',text:error.message}));}};
          range.addEventListener('change',loadAnalytics);await loadAnalytics();
          content.append(panel('Platform controls','Advertising is off by default. Premium checkout and creator withdrawal requests use the configured payment workflow.',el('div',{class:'console-grid'},[stat('Ad delivery',s.adsEnabled?'Enabled':'Off'),stat('Creator monetization',s.monetizationEnabled?'Enabled':'Off'),stat('Video sale fee',num(s.videoCommissionPercent??20)+'%'),stat('Playlist sale fee',num(s.playlistCommissionPercent??20)+'%')])));
        }
        if(['owner','admin'].includes(role)){const rows=(audit.events||[]).map(x=>tr(cell(el('strong',{text:x.action}),el('div',{class:'console-muted',text:x.reason||'—'})),cell(x.actorEmail),cell(dateText(x.createdAt)),cell(x.targetType+': '+text(x.targetId))));content.append(panel('Recent admin actions','Every sensitive moderation and platform change is attributed and reasoned.',rows.length?table(['Action','Admin','Date','Target'],rows):empty('No admin actions recorded yet.')));}
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
    const title=el('input',{type:'text',maxlength:'120',required:'',placeholder:'For example: Brand campaign'}),sponsor=el('input',{type:'text',maxlength:'120',required:'',placeholder:'Sponsor name'});
    const placement=select([['feed','Home feed native card'],['watch_sidebar','Watch page sidebar'],['channel','Creator channel sponsor'],['sticky_banner','Sticky banner'],['postroll','Post-roll sponsor'],['l_banner','L-shape squeeze-back']],'feed');
    const creative=el('input',{type:'url',required:'',placeholder:'HTTPS PC / desktop creative image URL'}),mobileCreative=el('input',{type:'url',required:'',placeholder:'HTTPS phone / mobile creative image URL'}),destination=el('input',{type:'url',required:'',placeholder:'HTTPS landing page URL'});
    const bottomCreative=el('input',{type:'url',placeholder:'HTTPS bottom creative image URL'}),bottomDestination=el('input',{type:'url',placeholder:'HTTPS bottom landing URL'});
    const monthlyCap=el('input',{type:'number',min:'1',max:'2147483647',step:'1',placeholder:'Blank = unlimited'});
    const cpm=el('input',{type:'number',min:'0',max:'1000000',step:'0.01',value:'0',required:''}),starts=el('input',{type:'datetime-local'}),ends=el('input',{type:'datetime-local'});
    let adLayouts=AD_LAYOUT_DEFAULTS;
    const previewImage=el('img',{alt:'Campaign creative preview',class:'campaign-preview-image'}),previewFrame=el('div',{class:'campaign-preview-frame'},[previewImage]),previewLink=el('a',{target:'_blank',rel:'noopener noreferrer',class:'campaign-preview-link',text:'Open landing page preview'}),previewMeta=el('small',{class:'campaign-preview-meta'}),preview=el('div',{class:'campaign-preview'},[previewFrame,previewLink,previewMeta]);
    const bottomPreviewImage=el('img',{alt:'L-shape bottom creative preview',class:'campaign-preview-image'}),bottomPreviewFrame=el('div',{class:'campaign-preview-frame'},[bottomPreviewImage]),bottomPreviewLink=el('a',{target:'_blank',rel:'noopener noreferrer',class:'campaign-preview-link',text:'Open bottom landing page'}),bottomPreviewMeta=el('small',{class:'campaign-preview-meta'}),bottomPreview=el('div',{class:'campaign-bottom-preview'},[bottomPreviewFrame,bottomPreviewLink,bottomPreviewMeta]);
    const bottomFields=el('div',{class:'l-banner-fields span-2'},[field('L-shape bottom image URL (HTTPS)',bottomCreative),field('L-shape bottom landing URL (HTTPS)',bottomDestination),field('Bottom creative preview',bottomPreview,'span-2')]);
    const setPreviewSize=(frame,meta,size,label)=>{const width=Number(size?.width)||640,height=Number(size?.height)||360,scale=Math.min(260/width,200/height);frame.style.width=`${width*scale}px`;frame.style.aspectRatio=`${width}/${height}`;meta.textContent=`${label} · ${width} × ${height} px · ${adRatioLabel(width,height)}`;};
    const syncPreview=()=>{const isLShape=placement.value==='l_banner',device=window.matchMedia('(max-width:760px)').matches?'mobile':'desktop',layout=adLayouts[placement.value]?.[device]||AD_LAYOUT_DEFAULTS[placement.value][device],mainSize=isLShape?layout.right:layout;bottomFields.hidden=!isLShape;bottomCreative.required=isLShape;bottomDestination.required=isLShape;previewImage.src=creative.value.trim();previewImage.alt=isLShape?'L-shape right-side creative':'Campaign creative preview';previewFrame.hidden=!creative.value.trim();previewLink.href=destination.value.trim()||'#';previewLink.hidden=!destination.value.trim();preview.classList.toggle('campaign-preview-empty',!creative.value.trim());preview.dataset.placement=placement.value;setPreviewSize(previewFrame,previewMeta,mainSize,isLShape?'Right poster':'Creative');bottomPreviewImage.src=bottomCreative.value.trim();bottomPreviewImage.alt='L-shape bottom creative';bottomPreviewFrame.hidden=!bottomCreative.value.trim();bottomPreviewLink.href=bottomDestination.value.trim()||'#';bottomPreviewLink.hidden=!bottomDestination.value.trim();setPreviewSize(bottomPreviewFrame,bottomPreviewMeta,layout.bottom||AD_LAYOUT_DEFAULTS.l_banner[device].bottom,'Bottom creative');};
    [creative,mobileCreative,destination,bottomCreative,bottomDestination].forEach(input=>input.addEventListener('input',syncPreview));placement.addEventListener('change',syncPreview);
    ctx.jsonFetch('/api/sponsor/settings').then(data=>{adLayouts=data.adLayoutSettings||AD_LAYOUT_DEFAULTS;syncPreview();}).catch(()=>{});
    const submit=el('button',{type:'submit',class:'primary-cta',text:'Create paused campaign'}),cancel=button('Cancel edit',()=>{editingId=null;form.reset();starts.value='';ends.value='';cpm.value='0';monthlyCap.value='';bottomCreative.value='';bottomDestination.value='';submit.textContent='Create paused campaign';cancel.hidden=true;syncPreview();},'console-small-button console-danger');cancel.hidden=true;
    const form=el('form',{class:'console-form'},[
      field('Campaign title',title),field('Sponsor',sponsor),field('Placement',placement),field('CPM (BDT / 1,000 impressions)',cpm),
      field('PC / desktop creative image URL (HTTPS)',creative),field('Phone / mobile creative image URL (HTTPS)',mobileCreative),field('Landing page URL (HTTPS)',destination,'span-2'),bottomFields,
      field('Monthly impression cap (campaign ID / UTC month)',monthlyCap,'span-2'),field('Start (optional)',starts),field('End (optional)',ends),field('Creative preview',preview,'span-2'),
      el('div',{class:'console-notice span-2',text:'Blank cap = unlimited. The campaign-ID cap is global per UTC calendar month and increments only after a unique impression is at least 50% visible for 1 second; duplicate events are ignored. At cap, the next eligible campaign rotates in. L-shape requires separate HTTPS image and landing URL for the bottom strip. Campaigns start paused; ads stay off until an Owner enables delivery. No advertiser billing or creator payout is implemented.'}),
      el('div',{class:'console-form-actions'},[submit,cancel])
    ]);
    syncPreview();
    form.addEventListener('submit',async event=>{event.preventDefault();submit.disabled=true;const payload={title:title.value,sponsorName:sponsor.value,placement:placement.value,creativeUrl:creative.value,desktopCreativeUrl:creative.value,mobileCreativeUrl:mobileCreative.value,destinationUrl:destination.value,bottomCreativeUrl:bottomCreative.value,bottomDestinationUrl:bottomDestination.value,monthlyImpressionCap:monthlyCap.value===''?null:Number(monthlyCap.value),cpmBdt:Number(cpm.value),startsAt:starts.value?new Date(starts.value).toISOString():null,endsAt:ends.value?new Date(ends.value).toISOString():null};try{await ctx.jsonFetch(editingId?'/api/admin/campaigns/'+encodeURIComponent(editingId):'/api/admin/campaigns',{method:editingId?'PUT':'POST',body:payload});ctx.notify(editingId?'Campaign details saved.':'Campaign created in paused state.');editingId=null;form.reset();starts.value='';ends.value='';cpm.value='0';monthlyCap.value='';submit.textContent='Create paused campaign';cancel.hidden=true;syncPreview();await loadCampaigns();}catch(error){ctx.notify(error.message,'error');}finally{submit.disabled=false;}});
    root.append(panel('Campaign editor','Create paused campaigns, set the global UTC-month impression cap per campaign, and preview the separate L-shape creatives.',form));
    const results=el('div');
    const loadCampaigns=async()=>{
      results.replaceChildren(empty('Loading campaigns…'));
      try{
        const params=new URLSearchParams({page:String(campaignPage),limit:'20',status:campaignStatus.value,q:campaignSearch.value.trim()});
        const data=await ctx.jsonFetch('/api/admin/campaigns?'+params);
        campaignPages=Math.max(1,data.pages||1);campaignPage=data.page||campaignPage;
        const rows=(data.campaigns||[]).map(c=>tr(
          cell(el('strong',{text:c.title}),el('div',{class:'console-muted',text:c.sponsorName+' · '+c.placement}),el('a',{href:c.destinationUrl,target:'_blank',rel:'noopener noreferrer',text:'Preview landing page'})),
          cell(statusBadge(c.status)),
          cell(num(c.monthlyImpressions)+' / '+(c.monthlyImpressionCap==null?'∞':num(c.monthlyImpressionCap))),
          cell(num(c.impressions)),cell(num(c.clicks)),
          cell((c.impressions?(c.clicks/c.impressions*100):0).toFixed(2)+'%'),
          cell(money(c.cpmBdt)+' CPM'),
          cell(el('div',{class:'console-actions'},[
            button('Edit',()=>{editingId=c.id;title.value=c.title;sponsor.value=c.sponsorName;placement.value=c.placement;creative.value=c.desktopCreativeUrl||c.creativeUrl;mobileCreative.value=c.mobileCreativeUrl||c.desktopCreativeUrl||c.creativeUrl;destination.value=c.destinationUrl;bottomCreative.value=c.bottomCreativeUrl||'';bottomDestination.value=c.bottomDestinationUrl||'';monthlyCap.value=c.monthlyImpressionCap==null?'':c.monthlyImpressionCap;cpm.value=c.cpmBdt;starts.value=asLocalDateTime(c.startsAt);ends.value=asLocalDateTime(c.endsAt);submit.textContent='Save campaign changes';cancel.hidden=false;syncPreview();form.scrollIntoView({behavior:'smooth',block:'start'});},'console-small-button'),
            button(c.status==='active'?'Pause':'Activate',async()=>{try{await ctx.jsonFetch('/api/admin/campaigns/'+encodeURIComponent(c.id)+'/status',{method:'PATCH',body:{status:c.status==='active'?'paused':'active'}});ctx.notify('Campaign status updated.');await loadCampaigns();}catch(error){ctx.notify(error.message,'error');}})
          ]))
        ));
        results.replaceChildren(rows.length?table(['Campaign','Status','UTC-month impressions / cap','Lifetime impressions','Clicks','CTR','Rate','Actions'],rows):empty('No campaigns match these filters.'),pager(campaignPage,campaignPages,next=>{campaignPage=next;loadCampaigns();}));
      }catch(error){results.replaceChildren(el('div',{class:'console-notice',text:error.message}));}
    };
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
    const role=select([['custom','Custom duties'],['admin','Admin (legacy full access)'],['moderator','Moderator (legacy safety access)']]);
    const template=select([['withdrawals','Withdrawals manager'],['reports','Reports manager'],['safety','Trust & Safety'],['creators','Creator operations'],['campaigns','Campaign manager'],['custom','Choose permissions manually']]);
    const permissionDefs=[['withdrawals:view','View withdrawal requests and payout details'],['withdrawals:manage','Approve/reject requests and mark paid'],['reports','Review reports and appeals'],['islamic','Review Islamic certifications'],['content','Manage content and user moderation'],['creators','Review creator/channel/shop applications'],['campaigns','Manage campaigns and settlements'],['payments','View and manage SMS payments'],['audit','Read the admin audit log'],['settings','Change platform settings']];
    const checks=new Map(permissionDefs.map(([key,label])=>[key,el('input',{type:'checkbox','data-permission':key,'aria-label':label})]));
    const permissionFields=el('div',{class:'staff-permission-grid'},permissionDefs.map(([key,label])=>field(label,checks.get(key))));
    const accessFields=el('div',{class:'staff-access-fields'},[field('Permission template',template),permissionFields]);
    const applyTemplate=value=>{const presets={withdrawals:['withdrawals:view','withdrawals:manage'],reports:['reports'],safety:['reports','islamic','content'],creators:['creators'],campaigns:['campaigns']};if(presets[value])checks.forEach((input,key)=>input.checked=presets[value].includes(key));};
    template.addEventListener('change',()=>applyTemplate(template.value));applyTemplate(template.value);
    const form=el('form',{class:'console-form'},[field('Google login email',email),field('Access type',role),accessFields,el('div',{class:'console-form-actions'},[el('button',{type:'submit',class:'primary-cta',text:'Save staff access'})])]);
    const syncFields=()=>{accessFields.hidden=role.value!=='custom';};role.addEventListener('change',syncFields);syncFields();
    form.addEventListener('submit',async event=>{event.preventDefault();const permissions=[...checks.entries()].filter(([,input])=>input.checked).map(([key])=>key);if(role.value==='custom'&&!permissions.length){ctx.notify('Select at least one permission.','error');return;}try{await ctx.jsonFetch('/api/admin/members',{method:'POST',body:{email:email.value,role:role.value,permissions}});ctx.notify('Staff access updated.');await renderStaff(root,ctx);}catch(error){ctx.notify(error.message,'error');}});
    root.append(panel('Assign staff duties','Choose a ready-made template or combine specific permissions. Payout destinations remain available only to staff explicitly assigned withdrawal access.',form));
    const permissionLabel=key=>permissionDefs.find(([id])=>id===key)?.[1]||key;
    const rows=(data.members||[]).map(m=>{const access=m.role==='owner'?'Owner':m.role==='admin'?'Admin (full legacy access)':m.role==='moderator'?'Moderator (safety legacy access)':(m.permissions||[]).map(permissionLabel).join(', ')||'No permissions';const controls=m.protected?el('span',{class:'console-muted',text:'Protected'}):el('div',{class:'console-actions'},[button('Edit duties',()=>{email.value=m.email;role.value=m.role==='custom'?'custom':m.role;checks.forEach(input=>input.checked=false);syncFields();(m.permissions||[]).forEach(p=>{if(checks.has(p))checks.get(p).checked=true;});template.value='custom';form.scrollIntoView({behavior:'smooth',block:'start'});}),button('Remove',async()=>{if(!confirm('এই staff access সরাবেন?'))return;try{await ctx.jsonFetch('/api/admin/members/'+encodeURIComponent(m.email),{method:'DELETE'});ctx.notify('Staff access সরানো হয়েছে।');await renderStaff(root,ctx);}catch(error){ctx.notify(error.message,'error');}},'console-small-button console-danger')]);return tr(cell(el('strong',{text:m.email}),m.protected?el('div',{class:'console-muted',text:'Bootstrap owner'}):null),cell(statusBadge(m.role,m.role==='owner'?'good':'')),cell(m.createdAt?dateText(m.createdAt):'Environment'),cell(el('span',{class:'staff-access-summary',text:access})),cell(controls));});
    root.append(panel('Current staff access','একজন staff-কে একাধিক department-এর দায়িত্ব দিতে পারবেন। Admin/Moderator পুরোনো access role হিসেবে অপরিবর্তিত থাকে.',rows.length?table(['Google account','Type','Added','Assigned permissions','Actions'],rows):empty('অন্য staff যোগ করা হয়নি।')));
  }

  const AD_LAYOUT_DEFAULTS={feed:{showSponsorDetails:true,desktop:{width:640,height:360},mobile:{width:360,height:203}},watch_sidebar:{showSponsorDetails:true,desktop:{width:184,height:138},mobile:{width:92,height:69}},channel:{showSponsorDetails:true,desktop:{width:720,height:405},mobile:{width:360,height:203}},sticky_banner:{showSponsorDetails:true,desktop:{width:960,height:320},mobile:{width:360,height:120}},postroll:{showSponsorDetails:true,desktop:{width:720,height:405},mobile:{width:360,height:203}},l_banner:{showSponsorDetails:true,desktop:{right:{width:150,height:642},bottom:{width:320,height:78}},mobile:{right:{width:40,height:167},bottom:{width:160,height:39}}}};
  const adRatioLabel=(width,height)=>{const ratio=Number(width)/Number(height);if(!Number.isFinite(ratio)||ratio<=0)return'—';return ratio>=1?`${ratio.toFixed(2)}:1`:`1:${(1/ratio).toFixed(2)}`;};
  function buildAdLayoutEditor(source={}){
    const labels={feed:'Home feed',watch_sidebar:'Watch sidebar',channel:'Creator channel',sticky_banner:'Sticky banner',postroll:'Post-roll',l_banner:'L-shape'};
    const refs={},displayRefs={};
    function sizeControl(placement,device,part,label){
      const fallback=part?AD_LAYOUT_DEFAULTS[placement][device][part]:AD_LAYOUT_DEFAULTS[placement][device];
      const actual=part?source?.[placement]?.[device]?.[part]:source?.[placement]?.[device];
      const width=el('input',{type:'number',min:'20',max:'4096',step:'1',required:'',value:actual?.width??fallback.width});
      const height=el('input',{type:'number',min:'20',max:'4096',step:'1',required:'',value:actual?.height??fallback.height});
      const ratio=el('strong',{class:'ad-layout-ratio'}),sample=el('div',{class:'ad-layout-sample'});
      const update=()=>{const w=Number(width.value),h=Number(height.value);if(!w||!h){ratio.textContent='Enter width and height';sample.style.width='0';sample.style.height='0';sample.textContent='';return;}const scale=Math.min(150/w,90/h);ratio.textContent=`${w} × ${h} px · ${adRatioLabel(w,h)}`;sample.style.width=`${w*scale}px`;sample.style.height=`${h*scale}px`;sample.textContent=`${w}×${h}`;};
      width.addEventListener('input',update);height.addEventListener('input',update);update();
      if(!refs[placement])refs[placement]={};
      if(!refs[placement][device])refs[placement][device]={};
      const item={width,height};
      if(part)refs[placement][device][part]=item;else refs[placement][device]=item;
      return el('div',{class:'ad-layout-size'},[el('h4',{text:label}),el('div',{class:'ad-layout-dimensions'},[field('Width (px)',width),field('Height (px)',height)]),ratio,el('div',{class:'ad-layout-sample-wrap'},[sample])]);
    }
    const cards=Object.entries(labels).map(([placement,label])=>{
      const showSponsorDetails=el('input',{type:'checkbox',checked:source?.[placement]?.showSponsorDetails!==false&&source?.[placement]?.showTitle!==false&&source?.[placement]?.showLandingLink!==false});
      displayRefs[placement]=showSponsorDetails;
      const displayControls=el('div',{class:'ad-layout-display-controls'},[
        el('label',{class:'console-toggle'},[showSponsorDetails,el('span',{text:'Show sponsor label, title and landing button'})])
      ]);
      const desktop=placement==='l_banner'?el('div',{class:'ad-layout-device'},[el('h3',{text:'PC · right image'}),sizeControl(placement,'desktop','right','Right-side poster'),el('h3',{text:'PC · bottom image'}),sizeControl(placement,'desktop','bottom','Bottom-banner creative')]):el('div',{class:'ad-layout-device'},[el('h3',{text:'PC / Desktop'}),sizeControl(placement,'desktop',null,label+' creative')]);
      const mobile=placement==='l_banner'?el('div',{class:'ad-layout-device'},[el('h3',{text:'Phone · right image'}),sizeControl(placement,'mobile','right','Right-side poster'),el('h3',{text:'Phone · bottom image'}),sizeControl(placement,'mobile','bottom','Bottom-banner creative')]):el('div',{class:'ad-layout-device'},[el('h3',{text:'Phone / Mobile'}),sizeControl(placement,'mobile',null,label+' creative')]);
      return el('section',{class:'ad-layout-card'},[el('h3',{text:label}),displayControls,el('div',{class:'ad-layout-device-grid'},[desktop,mobile])]);
    });
    return {node:el('div',{class:'ad-layout-editor'},cards),serialize(){
      const result={};
      for(const [placement,devices] of Object.entries(refs)){
        result[placement]={showSponsorDetails:displayRefs[placement].checked};
        for(const [device,parts] of Object.entries(devices)){
          if(placement==='l_banner'){
            result[placement][device]={};
            for(const [part,size] of Object.entries(parts))result[placement][device][part]={width:Number(size.width.value),height:Number(size.height.value)};
          }else{const size=parts;result[placement][device]={width:Number(size.width.value),height:Number(size.height.value)};}
        }
      }
      return result;
    }};
  }

  async function renderWithdrawals(root,ctx){
    const status=select([['pending','Pending'],['approved','Approved'],['rejected','Rejected'],['paid','Paid'],['all','All requests']],'pending'),list=el('div');
    async function load(){list.replaceChildren(empty('Loading withdrawal requests…'));try{const data=await ctx.jsonFetch('/api/admin/creator-withdrawals?status='+encodeURIComponent(status.value)),items=data.withdrawals||[];list.replaceChildren();if(!items.length){list.append(empty('No withdrawal requests in this view.'));return;}for(const item of items){const destination=item.payoutDetails||{},method=String(item.payoutMethod||'').toUpperCase(),copy=el('div',{class:'review-card-copy'},[el('div',{class:'review-card-meta'},[badge('@'+(item.handle||'creator'),'warn'),statusBadge(item.status),el('span',{text:dateText(item.createdAt)})]),el('h3',{text:item.creatorName+' · '+money(item.amountBdt)}),el('div',{class:'console-muted',text:item.email+' · '+method}),el('div',{class:'payout-destination'},[el('strong',{text:destination.accountName||'Account holder'}),el('span',{text:destination.accountNumber||'Destination unavailable'})]),item.decisionNote?el('p',{class:'console-notice',text:'Decision: '+item.decisionNote}):null,item.paidAt?el('div',{class:'console-muted',text:'Marked paid '+dateText(item.paidAt)}):null]),card=el('article',{class:'review-card withdrawal-review-card'},[copy]);
      if(['pending','approved'].includes(item.status)){const note=el('textarea',{rows:'2',maxlength:'2000',placeholder:'Decision note / payout reference (at least 5 characters)'}),actions=el('div',{class:'console-form-actions'});const decide=async action=>{if(note.value.trim().length<5){ctx.notify('Write a note of at least 5 characters.','error');note.focus();return;}try{await ctx.jsonFetch('/api/admin/creator-withdrawals/'+encodeURIComponent(item.id)+'/decision',{method:'POST',body:{action,note:note.value.trim()}});ctx.notify(action==='paid'?'Withdrawal marked paid.':'Withdrawal decision saved.');await load();}catch(error){ctx.notify(error.message,'error');}};if(item.status==='pending')actions.append(button('Approve',()=>decide('approve'),'primary-cta'),button('Reject',()=>decide('reject'),'console-small-button'));else actions.append(button('Mark as paid',()=>decide('paid'),'primary-cta'),button('Reject',()=>decide('reject'),'console-small-button'));card.append(el('div',{class:'review-card-actions'},[field('Admin note',note),actions]));}
      list.append(card);}}catch(error){list.replaceChildren(el('div',{class:'console-notice',text:error.message}));}}
    status.addEventListener('change',load);root.replaceChildren(panel('Creator withdrawals','Review encrypted payout destinations, approve requests, then mark them paid after an external/manual transfer. No money is moved automatically.',el('div',{},[el('div',{class:'studio-toolbar'},[field('Status',status)]),list])));await load();
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
    const lBannerSkippable=el('input',{type:'checkbox',checked:data.lBannerSkippable!==false});
    const feedAdEveryRows=el('input',{type:'number',min:'1',max:'20',step:'1',required:'',value:data.feedAdEveryRows||4});
    const adLayoutEditor=buildAdLayoutEditor(data.adLayoutSettings||{});
    const monet=el('input',{type:'checkbox',checked:data.monetizationEnabled});
    const share=el('input',{type:'number',min:'0',max:'100',step:'0.01',value:data.creatorSharePercent==null?'':data.creatorSharePercent,placeholder:'0–100'});
    const videoFee=el('input',{type:'number',min:'0',max:'100',step:'0.01',required:'',value:data.videoCommissionPercent??20});
    const playlistFee=el('input',{type:'number',min:'0',max:'100',step:'0.01',required:'',value:data.playlistCommissionPercent??20});
    const milestones=data.monetizationMilestones||{};
    const requiredSubscribers=el('input',{type:'number',min:'1',step:'1',required:'',value:milestones.requiredSubscribers||1000});
    const requiredWatchHours=el('input',{type:'number',min:'0.01',step:'0.01',required:'',value:milestones.requiredWatchHours||4000});
    const form=el('form',{class:'console-form'},[
      field('Ads delivery',el('span',{class:'console-toggle'},[ads,el('span',{text:'Active campaign থাকলে public ad slot দেখাও'})]),'span-2'),
      field('Feed ads',el('span',{class:'console-toggle'},[adFeed,el('span',{text:'Home native cards'})])),
      field('Watch sidebar ads',el('span',{class:'console-toggle'},[adWatch,el('span',{text:'Watch-page placement'})])),
      field('Creator channel ads',el('span',{class:'console-toggle'},[adChannel,el('span',{text:'Channel sponsor'})])),
      field('Sticky banner ads',el('span',{class:'console-toggle'},[adSticky,el('span',{text:'Sticky banner placement'})])),
      field('Post-roll ads',el('span',{class:'console-toggle'},[adPostroll,el('span',{text:'After video ends'})])),
      field('L-shape ads',el('span',{class:'console-toggle'},[adLBanner,el('span',{text:'Video squeeze-back'})])),
      field('L-shape duration (seconds)',lBannerDuration),
      field('L-shape skip button',el('span',{class:'console-toggle'},[lBannerSkippable,el('span',{text:'User × দিয়ে আগেই ad বন্ধ করতে পারবে'})])),
      field('Home feed ad interval (rows)',feedAdEveryRows),
      el('div',{class:'console-notice span-2',text:'প্রতিটি ad placement-এর “Show sponsor details” চালু থাকলে sponsor label, title, promoted text ও landing button দেখা যাবে; বন্ধ করলে creative image ছাড়া কোনো text থাকবে না। Image-এ click করলে landing page খোলা চলবে। Desktop home feed-এ নির্ধারিত প্রতিটি Nth row-তে ২টি video tile ও ১টি ad tile থাকে; phone-এ প্রতি Nটি video row-এর পর full-width ad আসে। Pixel size ও ratio device অনুযায়ী।'}),
      el('div',{class:'span-2'},[el('h3',{class:'ad-layout-heading',text:'Placement অনুযায়ী PC / phone pixel মাপ ও ratio'}),adLayoutEditor.node]),
      field('Creator monetization',el('span',{class:'console-toggle'},[monet,el('span',{text:'Eligible channel-গুলোর estimated revenue হিসাব করো'})]),'span-2'),
      field('Creator share (%)',share),
      field('Single video sale fee (%)',videoFee),
      field('Playlist sale fee (%)',playlistFee),
      field('Required subscribers',requiredSubscribers),
      field('Required watch hours',requiredWatchHours),
      el('div',{class:'console-notice span-2',text:'এই দুইটি milestone পূরণ হলে creator panel-এ eligibility দেখাবে। Video ও playlist sale fee সফল premium checkout-এর সময় snapshot হয়; বিদ্যমান sale/withdrawal balance-এ পরে পরিবর্তন প্রভাব ফেলে না। Ad creator share এবং CPM কেবল estimate গণনা করে.'}),
      el('div',{class:'console-form-actions'},[el('button',{type:'submit',class:'primary-cta',text:'Settings save'})])
    ]);
    form.addEventListener('submit',async event=>{event.preventDefault();try{await ctx.jsonFetch('/api/admin/settings',{method:'PUT',body:{adsEnabled:ads.checked,monetizationEnabled:monet.checked,creatorSharePercent:share.value===''?null:Number(share.value),videoCommissionPercent:Number(videoFee.value),playlistCommissionPercent:Number(playlistFee.value),monetizationMilestones:{requiredSubscribers:Number(requiredSubscribers.value),requiredWatchHours:Number(requiredWatchHours.value)},adToggles:{feed:adFeed.checked,watchSidebar:adWatch.checked,channel:adChannel.checked,sticky:adSticky.checked,postroll:adPostroll.checked,lBanner:adLBanner.checked},lBannerDurationSeconds:Number(lBannerDuration.value),lBannerSkippable:lBannerSkippable.checked,feedAdEveryRows:Number(feedAdEveryRows.value),adLayoutSettings:adLayoutEditor.serialize()}});ctx.notify('Platform settings save হয়েছে।');await renderSettings(root,ctx);}catch(error){ctx.notify(error.message,'error');}});
    root.append(panel('Platform monetization settings','Ads default-off থাকে। Campaign cap হলো campaign ID-প্রতি UTC calendar month-এ সর্বোচ্চ delivery; ফাঁকা cap মানে unlimited। Share percentage নিজের commercial policy অনুযায়ী নির্ধারণ করুন—এখানে কোনো default ভাগ ধরে নেওয়া হয়নি.',form));
  }

  window.AtharoConsole={renderStudio,renderAdmin,renderCreatorAssets};
})();
