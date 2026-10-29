// A single local player owns sound, including when the workbench is in the tray.
// It is independent of both the pet toggle and renderer navigation.
const clips=new Map();let current=null,revision=0;
function stop(){revision++;if(current){current.pause();current.currentTime=0;current=null;}document.body.dataset.playing='false';}
window.feedbackAudio.subscribe(async command=>{
 stop();if(!command)return;
 const {id,kind,style,volume}=command,version=revision;
 if(!['completed','attention','error'].includes(kind)||!['soft','pixel'].includes(style)||!Number.isInteger(volume)||volume<0||volume>100)return;
 try{
  const key=style+'-'+kind;let sound=clips.get(key);
  if(!sound){sound=new Audio('assets/'+key+'.wav');sound.preload='auto';clips.set(key,sound);}
  current=sound;sound.volume=volume/100;sound.currentTime=0;
  sound.onended=()=>{if(version===revision){document.body.dataset.playing='false';current=null;}};
  await sound.play();
  if(version===revision){document.body.dataset.playing='true';document.body.dataset.style=style;document.body.dataset.kind=kind;}
  window.feedbackAudio.report({id,ok:true});
 }catch(error){window.feedbackAudio.report({id,ok:version!==revision,error:String(error)});}
});
