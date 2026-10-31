/* Essoria connection composition, authored for HyperFrames 0.8.223.
   Draw-on connector timing informed by the HyperFrames flowchart primitive.
   All brand assets stay static and unchanged. */
(()=>{
const tl=gsap.timeline({paused:true});
tl.fromTo('#query-path',{strokeDashoffset:1},{strokeDashoffset:0,duration:1.4,ease:'none'},0.2);
tl.fromTo('#access-path',{strokeDashoffset:1},{strokeDashoffset:0,duration:1.4,ease:'none'},2.2);
tl.fromTo('#query-dot',{x:0,opacity:0},{x:-170,opacity:1,duration:1.4,ease:'none'},0.2);
tl.to('#query-dot',{opacity:0,duration:.15},1.65);
tl.fromTo('#permission-boundary rect',{stroke:'#496f67'},{stroke:'#61ddca',duration:.8},1.7);
tl.fromTo('#answer-dot',{x:0,opacity:0},{x:575,opacity:1,duration:2.1,ease:'none'},4.1);
tl.to('#answer-dot',{opacity:0,duration:.15},6.3);
const labels=['#phase-query','#phase-permission','#phase-response','#phase-control'];
labels.forEach((label,i)=>{tl.fromTo(label,{opacity:0},{opacity:1,duration:.15},i===3?5.8:i*2);if(i<3)tl.to(label,{opacity:0,duration:.1},i*2+1.85);});
tl.to('#permission-boundary rect',{stroke:'#91eedb',duration:1.1},6.7);
window.__timelines=window.__timelines||{};window.__timelines['essoria-connection']=tl;tl.seek(0);
// The web player is separate from the seekable composition. HyperFrames leaves it paused.
if(window.parent!==window){
 const reduced=matchMedia('(prefers-reduced-motion: reduce)');if(reduced.matches)tl.seek(7.9);
 tl.eventCallback('onComplete',()=>parent.postMessage({type:'essoria-motion',state:'complete'},location.origin));
 window.addEventListener('message',event=>{if(event.origin!==location.origin||event.source!==parent||event.data?.type!=='essoria-motion')return;if(event.data.action==='play'&&!reduced.matches){tl.restart();}else if(event.data.action==='pause')tl.pause();else if(event.data.action==='resume'&&!reduced.matches)tl.play();else if(event.data.action==='static')tl.pause().seek(7.9);});
 reduced.addEventListener('change',()=>{if(reduced.matches)tl.pause().seek(7.9);});
}
})();
