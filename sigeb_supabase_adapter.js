(function(){
'use strict';

const ADAPTER_VERSION='SIGEB-SUPABASE-1.0';
const CONFIG_KEY='sigeb_supabase_public_config_v1';
const $=id=>document.getElementById(id);
const esc=v=>String(v??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
const norm=v=>String(v||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim();
const cleanDni=v=>String(v||'').replace(/\D/g,'').padStart(8,'0').slice(-8);
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

let sb=null;
let activeSession=null;
let profile=null;
let bootstrap=null;
let realtimeChannel=null;
let booting=false;
let refreshTimer=null;
let remoteDistribution=[];
const beneficiaryCache=new Map();
const openedCaseData=new Map();

const uiOpenCase=window.openCase;
const uiRenderHistorial=window.renderHistorialBecario;
const uiRenderAll=window.renderAll;
const uiRenderAdminDistribution=window.renderAdminDistribution;

function getStoredConfig(){
  try{return JSON.parse(localStorage.getItem(CONFIG_KEY)||'{}')}catch(e){return {}}
}
function resolveConfig(){
  const inline=window.SIGEB_CONFIG||{};
  const stored=getStoredConfig();
  return {
    url:String(inline.supabaseUrl||inline.url||stored.url||'').trim(),
    key:String(inline.supabaseAnonKey||inline.publishableKey||inline.key||stored.key||'').trim(),
    bucket:String(inline.storageBucket||stored.bucket||'evidencias').trim()||'evidencias'
  };
}
function isConfigured(cfg=resolveConfig()){
  return /^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/i.test(cfg.url)
    && cfg.key.length>20
    && !/TU-PROYECTO|TU_CLAVE|REEMPLAZAR/i.test(cfg.url+cfg.key);
}
function saveConfig(url,key){
  localStorage.setItem(CONFIG_KEY,JSON.stringify({url:String(url||'').trim(),key:String(key||'').trim(),bucket:'evidencias'}));
  sb=null;
}
function ensureClient(){
  if(sb)return sb;
  const cfg=resolveConfig();
  if(!isConfigured(cfg))throw new Error('Falta configurar la URL del proyecto y la clave pública de Supabase.');
  if(!window.supabase?.createClient)throw new Error('No se pudo cargar la biblioteca de conexión con Supabase.');
  sb=window.supabase.createClient(cfg.url,cfg.key,{
    auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true},
    global:{headers:{'x-client-info':'sigeb-web/'+ADAPTER_VERSION}}
  });
  return sb;
}
async function rpc(name,args={}){
  const client=ensureClient();
  const {data,error}=await client.rpc(name,args);
  if(error)throw new Error(error.message||('Error al ejecutar '+name));
  return data;
}
function showError(message){
  const box=$('v83LoginError');
  if(box){box.textContent=message;box.classList.add('show')}
  else if(typeof toast==='function')toast('Error',message);
}
function clearError(){const box=$('v83LoginError');if(box){box.textContent='';box.classList.remove('show')}}
function setBusy(on,label='Procesando...'){
  let overlay=$('sigebRemoteBusy');
  if(!overlay){
    overlay=document.createElement('div');overlay.id='sigebRemoteBusy';
    overlay.innerHTML='<div class="sigeb-remote-spinner"></div><strong id="sigebRemoteBusyText">Procesando...</strong>';
    document.body.appendChild(overlay);
  }
  const text=$('sigebRemoteBusyText');if(text)text.textContent=label;
  overlay.classList.toggle('active',!!on);
}
function formatDateTime(v){
  if(!v)return '';
  try{return new Date(v).toLocaleString('es-PE',{dateStyle:'short',timeStyle:'short'})}catch(e){return String(v)}
}
function calcAge(date){
  if(!date)return '';
  const d=new Date(date);if(Number.isNaN(d.getTime()))return '';
  const n=new Date();let a=n.getFullYear()-d.getFullYear();
  if(n.getMonth()<d.getMonth()||(n.getMonth()===d.getMonth()&&n.getDate()<d.getDate()))a--;
  return a;
}
function caseTypeLabel(type){
  const n=norm(type);
  if(n.includes('alert'))return 'Alerta Académica';
  if(n.includes('orient'))return 'Orientación';
  if(n.includes('riesgo')||n.includes('protocolo'))return 'Riesgo Social';
  return type||'Caso';
}
function caseTypeDb(type){
  const n=norm(type);
  if(n.includes('alert'))return 'alerta';
  if(n.includes('orient'))return 'orientacion';
  if(n.includes('riesgo')||n.includes('protocolo'))return 'riesgo_social';
  return n;
}
function normalizeBeneficiary(b){
  if(!b)return null;
  return {
    dni:cleanDni(b.dni),nombre:b.nombre||b.nombre_completo||'',region:b.region||b.region_operativa||'',regionOrigen:b.region_origen||'',region_id:Number(b.region_id)||null,
    ies:b.ies||'',carrera:b.carrera||'',beca:b.beca||'',modalidad:b.modalidad||'',convocatoria:b.convocatoria||b.anio_conv||'',expediente:b.expediente||'',
    sexo:b.sexo||'',fechaNacimiento:b.fecha_nacimiento||'',edad:calcAge(b.fecha_nacimiento),telefono:b.telefono||b.celular_intranet||'',correo:b.correo||b.correo_personal_intranet||'',
    estadoBecario:b.estado_becario||'',paisEstudio:b.pais_estudio||''
  };
}
function normalizeAction(a){
  return {
    key:a.id||('A'+Math.random()),tipo:a.titulo||a.action_type||'Actualización',detalle:a.detalle||'',fecha:(a.metadata&&a.metadata.fecha)||String(a.created_at||'').slice(0,10),
    usuario:a.created_by_nombre||'',estado:a.estado_resultante||'',actionType:a.action_type||'',createdAt:a.created_at||'',metadata:a.metadata||{}
  };
}
function normalizeAttention(a){
  return {n:a.numero_sesion||a.n||1,fecha:a.fecha_sesion||a.fecha||'',detalle:a.acciones_seguimiento||a.detalle||'',responsable:a.responsable_seguimiento||a.responsable||'',requiereContinuar:!!(a.requiere_continuar_seguimiento??a.requiere_continuar)};
}
function normalizeCase(row){
  if(!row)return null;
  const d=row.datos||{};
  const t=caseTypeLabel(row.case_type||row.tipo);
  const c={
    id:row.id,_caseType:caseTypeDb(row.case_type||row.tipo),tipo:t,dni:cleanDni(row.dni),beneficiario:row.beneficiario||'',
    region:row.region_operativa||row.region||'',regionOrigen:row.region_origen||'',region_id:Number(row.region_id)||null,ies:row.ies||'',carrera:row.carrera||'',beca:row.beca||'',modalidad:row.modalidad||d.modalidad||'',convocatoria:row.anio_conv||'',expediente:row.expediente||'',sexo:row.sexo||'',fechaNacimiento:row.fecha_nacimiento||'',edad:calcAge(row.fecha_nacimiento),
    telefono:row.celular_intranet||'',correo:row.correo_personal_intranet||'',contacto:{telefono:row.celular_intranet||'',correo:row.correo_personal_intranet||''},
    fecha:row.fecha||'',fechaConocimiento:row.fecha||'',createdAt:row.created_at||'',updatedAt:row.updated_at||'',
    estado:row.estado||'En seguimiento',estadoAlerta:row.estado||'',detalle:row.detalle||'',comentario:row.detalle||'',responsable:row.responsable||'',responsableRegistro:row.responsable||'',
    monitora:row.monitora_nombre||'Sin asignar',monitoraUserId:row.monitora_user_id||null,evidencias:(row.evidencias||[]).map(e=>({id:e.id,nombre:e.file_name,tipo:e.mime_type,path:e.storage_path,size:e.size_bytes,fecha:e.created_at})),
    accionesCount:Number(row.acciones_count||0),comentariosCount:Number(row.comentarios_count||0)
  };
  if(t==='Alerta Académica'){
    c.riesgo=d.riesgo||'';c.nivel=d.prioridad||'';c.tipoAlerta=d.tipo_alerta||'';c.orientacion=d.orientacion_brindada||'';c.derivadoIES=!!d.derivado_ies;
    c.estadoValidacionIES=d.estado_validacion_ies||'';c.resultadoIES=d.resultado_ies||{};c.estadoIES=(d.resultado_ies&&d.resultado_ies.estado_academico)||d.estado_validacion_ies||'Pendiente IES';
    c.fechaConocimientoAutomatico=d.tomado_conocimiento_at||'';c.fechaFinalizacionIES=d.finalizado_at||'';c.comunicacion=d.estado_comunicacion||'';
    c.accionesAlerta=(row.acciones||[]).map(normalizeAction);
  }else if(t==='Orientación'){
    c.tipoAtencion=d.tipo_orientacion||'';c.motivo=d.motivo||'';c.resultadoCierre=d.resultado_cierre||'';c.esAlerta=!!d.es_alerta;c.tipoAlerta=d.tipo_alerta||'';c.dependencia=d.dependencia_alerta||'';c.detalleAlerta=d.detalle_alerta||'';
  }else{
    c.protocolo=d.tipo_riesgo||'';c.riesgoSocial=d.tipo_riesgo||'';c.orientacion=d.orientacion||'';c.oficio=d.corresponde_oficio?'Sí':'No';c.fechaOficio=d.fecha_oficio||'';c.numeroOficio=d.numero_oficio||'';c.resultadoCierre=d.resultado_cierre||'';c.requiereAtencionAdicional=!!d.requiere_atencion_adicional;
    c.atenciones=(row.atenciones||[]).map(normalizeAttention);c.sesiones=c.atenciones;c.fechaAtencion=c.atenciones.length?('Atención '+c.atenciones.length):'';
  }
  return c;
}
function normalizeRequest(s){
  const typeMap={creacion_alerta:'carga_alerta',validacion_ies:'validacion_ies',edicion:'edicion',correccion:'edicion',eliminacion:'eliminacion'};
  const monitor=(bootstrap?.monitoras||[]).find(m=>m.user_id===s.destinatario_user_id);
  const payload=s.tipo_solicitud==='validacion_ies'
    ? {accionesIES:`Carga con ${s.metadata?.total||0} caso(s)`,resultadoAcciones:'Pendiente de revisión',cargaId:s.metadata?.carga_id||''}
    : (s.datos_propuestos||{});
  return {
    id:s.id,tipo:typeMap[s.tipo_solicitud]||s.tipo_solicitud,rawType:s.tipo_solicitud,caseId:s.case_id||'',caseType:s.case_type||'',dni:s.dni||'',beneficiario:s.beneficiario||'',region_id:s.region_id||null,
    region:(bootstrap?.regions||[]).find(r=>Number(r.id)===Number(s.region_id))?.nombre||'',ies:s.ies||'',intervencion:caseTypeLabel(s.case_type),motivo:s.motivo||'',campos:Array.isArray(s.campos_modificados)?s.campos_modificados.join(', '):JSON.stringify(s.campos_modificados||[]),
    valores:s.datos_propuestos||{},payload,solicitante:s.solicitante_nombre||'',solicitanteRol:s.solicitante_rol||'',destinatarioUserId:s.destinatario_user_id||'',monitora:monitor?.nombre||'',
    estado:s.estado||'Pendiente',respuesta:s.respuesta_admin||'',fecha:formatDateTime(s.created_at),fechaDecision:formatDateTime(s.fecha_decision),metadata:s.metadata||{},datosAnteriores:s.datos_anteriores||{},datosPropuestos:s.datos_propuestos||{}
  };
}
function normalizeNotification(n){
  return {id:n.id,caseType:n.case_type||'',caseId:n.case_id||'',eventType:n.event_type||'',title:n.titulo||'Notificación',message:n.mensaje||'',read:!!n.leida,date:formatDateTime(n.created_at),metadata:n.metadata||{}};
}
function cacheBeneficiary(b){const n=normalizeBeneficiary(b);if(n?.dni)beneficiaryCache.set(n.dni,n);return n}
function replaceCase(c){
  if(!c)return;
  const i=(state.cases||[]).findIndex(x=>x.id===c.id);
  if(i>=0)state.cases.splice(i,1,c);else state.cases.unshift(c);
  openedCaseData.set(c.id,c);
  state.audit=(state.audit||[]).filter(a=>a.caseId!==c.id);
  const full=openedCaseData.get(c.id);
  const comments=(full?._rawComments||[]);
  comments.forEach(cm=>state.audit.push({caseId:c.id,accion:'Comentario',usuario:cm.created_by_nombre||'Usuario',fecha:formatDateTime(cm.created_at),detalle:cm.comentario||''}));
}
function setOpenedComments(c,row){
  c._rawComments=row.comentarios||[];
  replaceCase(c);
}

async function refreshData(options={}){
  if(!activeSession)return;
  const [cases,requests,notifications,distribution]=await Promise.all([
    rpc('sigeb_listar_casos',{p_filtros:{limit:3000}}),
    rpc('sigeb_listar_solicitudes',{p_limit:1000}),
    rpc('sigeb_listar_notificaciones',{p_limit:100}),
    rpc('sigeb_listar_distribucion_monitoras')
  ]);
  state.cases=(cases||[]).map(normalizeCase).filter(Boolean);
  state.solicitudes=(requests||[]).map(normalizeRequest);
  state.notifications=(notifications||[]).map(normalizeNotification);
  remoteDistribution=distribution||[];
  if(options.render!==false){
    if(typeof renderAll==='function')renderAll();
    renderSolicitudesRemote();
    renderNotificationsRemote();
    renderAdminDistributionRemote();
  }
}
async function bootstrapSession(session){
  if(booting)return;booting=true;setBusy(true,'Cargando SIGEB...');clearError();
  try{
    activeSession=session;
    bootstrap=await rpc('sigeb_bootstrap');
    profile=bootstrap.profile;
    if(!profile?.activo)throw new Error('El perfil SIGEB no se encuentra activo.');
    window.__SIGEB_SUPABASE__={client:sb,session,profile,bootstrap,version:ADAPTER_VERSION};
    window.currentUser=()=>profile?.nombre||'Usuario SIGEB';
    window.visibleCases=()=>state.cases||[];
    window.scopeText=()=>profile?.rol==='admin'?'Nacional':(bootstrap.regions||[]).map(r=>r.nombre).filter((v,i,a)=>a.indexOf(v)===i).join(', ');
    state.role=profile.rol;
    document.body.classList.remove('role-succor','role-monitora','role-admin');
    document.body.classList.add('siben-authenticated','role-'+profile.rol);
    if(typeof setRole==='function')setRole(profile.rol);
    if($('userName'))$('userName').textContent=profile.nombre;
    if($('userRole'))$('userRole').textContent=activeSession.user.email||profile.rol;
    if($('avatar'))$('avatar').textContent=profile.rol==='admin'?'A':profile.rol==='monitora'?'M':'S';
    const regionPill=document.querySelector('.region-pill');if(regionPill)regionPill.innerHTML='Ámbito<br><b>'+esc(window.scopeText()||'Nacional')+'</b>';
    ensureLogoutButton();
    await refreshData({render:false});
    subscribeRealtime();
    if(typeof renderAll==='function')renderAll();
    renderSolicitudesRemote();renderNotificationsRemote();renderAdminDistributionRemote();
    const start=profile.rol==='succor'?'registro':profile.rol==='monitora'?'seguimiento':'dashboard';
    if(typeof showView==='function')showView(start,document.querySelector(`.side-link[data-view="${start}"]`));
  }catch(e){
    console.error(e);showError(e.message||'No se pudo iniciar SIGEB.');
    document.body.classList.remove('siben-authenticated','role-succor','role-monitora','role-admin');
    try{await sb?.auth.signOut()}catch(_e){}
  }finally{booting=false;setBusy(false)}
}
function ensureLogoutButton(){
  const actions=document.querySelector('.siben-actions');if(!actions)return;
  let old=$('v83LogoutBtn');
  if(old){const clone=old.cloneNode(true);old.replaceWith(clone);old=clone}
  else{old=document.createElement('button');old.id='v83LogoutBtn';old.className='btn btn-ghost';old.textContent='Cerrar sesión';actions.insertBefore(old,actions.querySelector('.user-pill')||null)}
  old.type='button';old.onclick=async()=>{setBusy(true,'Cerrando sesión...');try{await ensureClient().auth.signOut()}finally{setBusy(false);resetSignedOutUI()}};
}
function resetSignedOutUI(){
  activeSession=null;profile=null;bootstrap=null;state.cases=[];state.audit=[];state.solicitudes=[];state.notifications=[];
  if(realtimeChannel&&sb){sb.removeChannel(realtimeChannel);realtimeChannel=null}
  document.body.classList.remove('siben-authenticated','role-succor','role-monitora','role-admin');
  $('modal')?.classList.remove('active');
  const form=$('v83LoginForm');form?.reset();clearError();setTimeout(()=>$('v83Email')?.focus(),30);
}
function subscribeRealtime(){
  if(!sb||!activeSession)return;
  if(realtimeChannel)sb.removeChannel(realtimeChannel);
  realtimeChannel=sb.channel('sigeb-live-'+activeSession.user.id)
    .on('postgres_changes',{event:'*',schema:'public',table:'notificaciones'},scheduleRefresh)
    .on('postgres_changes',{event:'*',schema:'public',table:'solicitudes_admin'},scheduleRefresh)
    .on('postgres_changes',{event:'*',schema:'public',table:'caso_comentarios'},scheduleRefresh)
    .on('postgres_changes',{event:'*',schema:'public',table:'caso_acciones'},scheduleRefresh)
    .subscribe();
}
function scheduleRefresh(){
  clearTimeout(refreshTimer);refreshTimer=setTimeout(()=>refreshData().catch(console.error),450);
}

function renderConfigBox(){
  const panel=document.querySelector('.v83-login-panel');if(!panel)return;
  let box=$('sigebConfigBox');if(!box){
    box=document.createElement('details');box.id='sigebConfigBox';box.className='sigeb-config-box';
    box.innerHTML='<summary>Configuración inicial del sistema</summary><div class="sigeb-config-grid"><label>URL del proyecto<input id="sigebCfgUrl" type="url" placeholder="https://proyecto.supabase.co"></label><label>Clave pública<input id="sigebCfgKey" type="password" placeholder="Clave publishable o anon"></label><button id="sigebCfgSave" class="btn btn-dark" type="button">Guardar configuración</button><small>Utilice únicamente una clave pública. No ingrese la clave de servicio.</small></div>';
    panel.appendChild(box);
  }
  const cfg=resolveConfig();if($('sigebCfgUrl'))$('sigebCfgUrl').value=isConfigured(cfg)?cfg.url:'';
  $('sigebCfgSave').onclick=()=>{
    const url=$('sigebCfgUrl').value,key=$('sigebCfgKey').value;
    saveConfig(url,key);
    try{ensureClient();box.open=false;showError('Configuración guardada. Ingrese sus credenciales institucionales.')}catch(e){showError(e.message)}
  };
  box.open=!isConfigured(cfg);
}
function bindLogin(){
  const old=$('v83LoginForm');if(!old)return;
  const form=old.cloneNode(true);old.replaceWith(form);
  const access=document.querySelector('.v83-access-note');if(access)access.remove();
  const p=document.querySelector('.v83-login-panel>p');if(p)p.textContent='Ingrese el correo y la contraseña registrados en el sistema institucional.';
  form.addEventListener('submit',async ev=>{
    ev.preventDefault();clearError();
    const email=$('v83Email')?.value.trim(),password=$('v83Password')?.value||'';
    if(!email||!password)return showError('Ingrese usuario y contraseña.');
    try{
      setBusy(true,'Validando credenciales...');const client=ensureClient();
      const {data,error}=await client.auth.signInWithPassword({email,password});
      if(error)throw error;
      await bootstrapSession(data.session);
    }catch(e){showError(e.message||'Credenciales incorrectas.')}finally{setBusy(false)}
  });
  $('v83TogglePassword')?.addEventListener('click',()=>{const p=$('v83Password');if(!p)return;p.type=p.type==='password'?'text':'password';p.focus()});
  ['v83Email','v83Password'].forEach(id=>$(id)?.addEventListener('input',clearError));
  renderConfigBox();
}
async function initAuth(){
  ['siben_demo_session_v83','gb_demo_v58','sigeb_v92_state'].forEach(k=>localStorage.removeItem(k));
  document.body.classList.remove('siben-authenticated','role-succor','role-monitora','role-admin');
  bindLogin();
  if(!isConfigured())return;
  try{
    const client=ensureClient();
    client.auth.onAuthStateChange((event,session)=>{
      if(event==='SIGNED_OUT')resetSignedOutUI();
      if(session&&(event==='SIGNED_IN'||event==='TOKEN_REFRESHED'||event==='INITIAL_SESSION'))setTimeout(()=>bootstrapSession(session),0);
    });
    const {data,error}=await client.auth.getSession();if(error)throw error;
    if(data.session)await bootstrapSession(data.session);else $('v83Email')?.focus();
  }catch(e){showError(e.message)}
}

window.save=()=>{};
window.load=()=>{};
window.resetDemo=()=>toast('Acción deshabilitada','Los datos institucionales no pueden reiniciarse desde la aplicación.');
window.seedDemoCases=window.seedMassForIntervention=window.seedAdminAlertsForDistribution=window.seedSolicitudDemo=()=>toast('Acción deshabilitada','La versión conectada no utiliza datos de demostración.');
window.findBenef=dni=>beneficiaryCache.get(cleanDni(dni))||null;
window.renderRegions=function(){
  const regs=bootstrap?.regions||[];
  const opts='<option value="">Todas</option>'+regs.map(r=>`<option value="${esc(r.nombre)}" data-region-id="${esc(r.id)}">${esc(r.nombre)}</option>`).join('');
  if($('dashRegion'))$('dashRegion').innerHTML='<option value="">Consolidado</option>'+regs.map(r=>`<option value="${esc(r.nombre)}" data-region-id="${esc(r.id)}">${esc(r.nombre)}</option>`).join('');
  if($('filterConRegion'))$('filterConRegion').innerHTML=opts;
  if($('followRegion'))$('followRegion').innerHTML=opts;
  if($('assignRegion'))$('assignRegion').innerHTML='<option value="">Todas</option>'+regs.map(r=>`<option value="${esc(r.nombre)}" data-region-id="${esc(r.id)}">${esc(r.nombre)}</option>`).join('');
};

window.validateDNI=async function(){
  const raw=($('dniInput')?.value||'').trim();
  if(!/^\d{8}$/.test(raw)){if($('benefMount'))$('benefMount').innerHTML='<div class="notice" style="border-color:#fecaca;background:#fff1f2;color:#991b1b">El DNI debe tener exactamente 8 números.</div>';return}
  try{
    setBusy(true,'Consultando padrón...');const data=await rpc('sigeb_buscar_becario',{p_dni:raw});
    if(!data)throw new Error('DNI no encontrado en el padrón visible para este usuario.');
    const b=cacheBeneficiary(data);state.validated=b;
    $('benefMount').innerHTML=typeof benefHTML==='function'?benefHTML(b):`<div class="notice"><b>${esc(b.nombre)}</b></div>`;
    $('caseFormMount').classList.remove('hidden');$('caseFormMount').innerHTML=caseFormHTML(state.intervention,b);
  }catch(e){$('benefMount').innerHTML='<div class="notice" style="border-color:#fecaca;background:#fff1f2;color:#991b1b">'+esc(e.message)+'</div>';$('caseFormMount')?.classList.add('hidden')}finally{setBusy(false)}
};

function boolValue(id){const value=($(id)?.value||'').toLowerCase();return value==='sí'||value==='si'}
function formValue(id){return ($(id)?.value||'').trim()}
function normalizeRisk(v){const n=norm(v);if(n==='muy alto')return 'Muy alto';if(n==='alto')return 'Alto';if(n==='medio')return 'Medio';if(n==='bajo')return 'Bajo';return v||'Alto'}
function buildCasePayload(){
  const b=state.validated;if(!b)throw new Error('Primero valide el DNI.');
  const type=caseTypeDb(state.intervention);
  const common={case_type:type,dni:b.dni,responsable:formValue('responsableRegistro')||profile?.nombre,fecha:formValue('fecha')||new Date().toISOString().slice(0,10)};
  if(type==='alerta')return {...common,tipo_alerta:formValue('tipoAlerta')||'Riesgo académico',nivel_riesgo:normalizeRisk(formValue('riesgo')),nivel_prioridad:formValue('nivel')||'Prioridad Alta',prioridad:(formValue('nivel')||'Alta').replace('Prioridad ',''),detalle:formValue('detalle'),estado:'Abierto'};
  if(type==='orientacion')return {...common,modalidad:formValue('modalidad'),tipo_orientacion:formValue('tipoAtencion'),motivo:formValue('motivo'),detalle:formValue('detalle'),estado:formValue('estadoOri')||'En seguimiento',es_alerta:boolValue('esAlerta'),tipo_alerta:formValue('tipoAlerta'),dependencia_alerta:formValue('dependencia'),motivo_alerta:formValue('motivoAlerta'),detalle_alerta:formValue('detalleAlerta'),resultado_cierre:formValue('resultadoCierre')};
  return {...common,tipo_riesgo:formValue('tipoProt')||formValue('riesgoSocial')||'Otro riesgo social',detalle:formValue('detalle'),orientacion:formValue('orientacionBrindada'),corresponde_oficio:boolValue('oficio'),fecha_oficio:formValue('fechaOficio'),numero_oficio:formValue('numeroOficio'),estado:formValue('estadoProt')||'En seguimiento',atencion_fecha:formValue('sesion1Fecha'),atencion_detalle:formValue('sesion1Detalle'),requiere_atencion_adicional:boolValue('req2'),resultado_cierre:formValue('resultadoCierre')};
}
async function uploadEvidenceFiles(caseType,caseId,dni){
  const files=[...($('evidencias')?.files||[])];if(!files.length)return;
  for(const file of files){
    if(file.size>2097152)throw new Error(`${file.name}: supera el máximo de 2 MB.`);
    if(!['application/pdf','image/jpeg','image/png'].includes(file.type))throw new Error(`${file.name}: formato no permitido.`);
    const safeName=file.name.replace(/[^a-zA-Z0-9._-]+/g,'_');const path=`${activeSession.user.id}/${caseType}/${caseId}/${crypto.randomUUID()}-${safeName}`;
    const {error}=await ensureClient().storage.from(resolveConfig().bucket).upload(path,file,{upsert:false,contentType:file.type});if(error)throw error;
    await rpc('sigeb_vincular_evidencia',{p_case_type:caseType,p_case_id:caseId,p_dni:dni,p_file_name:file.name,p_mime_type:file.type,p_storage_path:path,p_size_bytes:file.size,p_descripcion:null});
  }
}
window.createCase=async function(){
  try{
    const payload=buildCasePayload();
    if(payload.case_type==='alerta'&&profile?.rol!=='admin')return crearSolicitudCargaAlertaRemote(payload);
    if(!payload.detalle&&payload.case_type!=='alerta')throw new Error('Complete el detalle principal del caso.');
    setBusy(true,'Registrando expediente...');const result=await rpc('sigeb_crear_caso',{p_payload:payload});
    await uploadEvidenceFiles(payload.case_type,result.case_id,payload.dni);
    await refreshData({render:false});if(typeof renderAll==='function')renderAll();
    if(typeof backToIntervention==='function')backToIntervention();if(typeof showView==='function')showView('seguimiento');
    if(typeof setFollowType==='function')setFollowType(caseTypeLabel(payload.case_type));
    toast('Expediente registrado','La información fue guardada correctamente.');
  }catch(e){toast('No se pudo registrar',e.message)}finally{setBusy(false)}
};

async function crearSolicitudCargaAlertaRemote(payloadOverride){
  try{
    const dni=payloadOverride?.dni||cleanDni(formValue('reqDni'));if(!/^\d{8}$/.test(dni))throw new Error('Ingrese un DNI válido de 8 números.');
    const b=cacheBeneficiary(await rpc('sigeb_buscar_becario',{p_dni:dni}));if(!b)throw new Error('DNI no encontrado en el padrón visible.');
    const risk=normalizeRisk(payloadOverride?.nivel_riesgo||formValue('reqRiesgo')||'Alto');const reason=payloadOverride?.detalle||formValue('reqMotivo')||'Solicitud de ingreso de Alerta Académica';
    const proposed=payloadOverride||{case_type:'alerta',dni,nivel_riesgo:risk,nivel_prioridad:['Muy alto','Alto'].includes(risk)?'Prioridad Alta':'Prioridad Media',prioridad:['Muy alto','Alto'].includes(risk)?'Alta':'Media',detalle:reason,tipo_alerta:'Riesgo académico',fecha:new Date().toISOString().slice(0,10),responsable:profile.nombre};
    setBusy(true,'Enviando solicitud...');await rpc('sigeb_crear_solicitud',{p_payload:{tipo_solicitud:'creacion_alerta',case_type:'alerta',dni,beneficiario:b.nombre,region_id:b.region_id,asunto:'Ingreso de Alerta Académica',motivo:reason,datos_propuestos:proposed,campos_modificados:Object.keys(proposed)}});
    await refreshData();$('modal')?.classList.remove('active');toast('Solicitud enviada','El Administrador revisará el ingreso de la alerta.');
  }catch(e){toast('No se pudo enviar',e.message)}finally{setBusy(false)}
}
window.crearSolicitudCargaAlerta=()=>crearSolicitudCargaAlertaRemote();

window.openCase=async function(cid){
  const base=(state.cases||[]).find(x=>x.id===cid);if(!base)return;
  try{
    setBusy(true,'Abriendo expediente...');const row=await rpc('sigeb_abrir_caso',{p_case_type:base._caseType||caseTypeDb(base.tipo),p_case_id:cid});
    const c=normalizeCase(row);setOpenedComments(c,row);c._rawActions=row.acciones||[];
    if(typeof uiOpenCase==='function')uiOpenCase(cid);
    if(profile?.rol==='admin'){
      const actions=document.querySelector('#modalBody .v88-actions');
      if(actions&&!actions.querySelector('[data-admin-edit]'))actions.insertAdjacentHTML('afterbegin',`<button class="btn btn-ghost" data-admin-edit onclick="openEditDeleteRequest84('${esc(cid)}')">Editar caso</button>`);
    }
  }catch(e){toast('No se pudo abrir',e.message)}finally{setBusy(false)}
};
window.addCaseComment=async function(cid){
  const c=(state.cases||[]).find(x=>x.id===cid),txt=formValue('auditComment');if(!c||!txt)return toast('Comentario requerido','Escriba un comentario.');
  try{setBusy(true,'Guardando comentario...');await rpc('sigeb_agregar_comentario',{p_case_type:c._caseType,p_case_id:cid,p_comentario:txt});await window.openCase(cid);await refreshData({render:false});renderNotificationsRemote();toast('Comentario guardado','La contraparte fue notificada.')}catch(e){toast('No se pudo guardar',e.message)}finally{setBusy(false)}
};
window.saveAcademicV92=async function(cid){
  const c=(state.cases||[]).find(x=>x.id===cid);if(!c)return;
  const date=formValue('v92AlertDate')||new Date().toISOString().slice(0,10),orientation=formValue('v92Orientacion'),derived=formValue('v92Derivado')==='Sí',detail=formValue('v92Derivacion');
  if(!orientation&&!derived)return toast('Información requerida','Registre una orientación o una derivación a la IES.');if(derived&&!detail)return toast('Detalle requerido','Describa la derivación a la IES.');
  try{
    setBusy(true,'Guardando acciones...');
    if(orientation)await rpc('sigeb_registrar_accion',{p_case_type:'alerta',p_case_id:cid,p_action_type:'orientacion_registrada',p_titulo:'Orientación registrada',p_detalle:orientation,p_estado_resultante:'En seguimiento',p_metadata:{fecha:date,acta_firmada:formValue('v92Acta')==='Sí'}});
    if(derived)await rpc('sigeb_registrar_accion',{p_case_type:'alerta',p_case_id:cid,p_action_type:'derivacion_ies',p_titulo:'Derivado a la IES',p_detalle:detail,p_estado_resultante:'Derivado a la IES',p_metadata:{fecha:date}});
    await refreshData({render:false});await window.openCase(cid);toast('Acciones guardadas','Cada acción se incorporó al historial del caso.');
  }catch(e){toast('No se pudo actualizar',e.message)}finally{setBusy(false)}
};
window.saveAttention84=async function(cid){
  const c=(state.cases||[]).find(x=>x.id===cid);if(!c)return;
  const date=formValue('v84AttDate'),responsible=formValue('v84AttResp'),detail=formValue('v84AttDetail'),close=formValue('v84Close')==='Sí',reason=formValue('v84CloseReason');
  if(!date||!responsible||!detail)return toast('Información requerida','Complete fecha, profesional responsable y acciones realizadas.');if(close&&!reason)return toast('Resultado requerido','Seleccione el resultado de cierre.');
  try{
    setBusy(true,'Registrando atención...');await rpc('sigeb_registrar_accion',{p_case_type:'riesgo_social',p_case_id:cid,p_action_type:'atencion',p_titulo:'Atención registrada',p_detalle:detail,p_estado_resultante:close?'Cerrado':'En seguimiento',p_metadata:{fecha:date,responsable:responsible,requiere_continuar:!close,resultado_cierre:reason}});
    await refreshData({render:false});await window.openCase(cid);toast('Atención registrada','La atención se añadió sin límite fijo de sesiones.');
  }catch(e){toast('No se pudo registrar',e.message)}finally{setBusy(false)}
};
window.saveNextSession=async function(cid){
  const c=(state.cases||[]).find(x=>x.id===cid);if(!c)return;
  if(c._caseType==='riesgo_social')return window.saveAttention84(cid);
  const detail=formValue('newSessionDetalle'),date=formValue('newSessionFecha'),st=formValue('newSessionEstado')||c.estado;
  try{setBusy(true,'Guardando actualización...');await rpc('sigeb_registrar_accion',{p_case_type:c._caseType,p_case_id:cid,p_action_type:'seguimiento',p_titulo:'Actualización de seguimiento',p_detalle:detail,p_estado_resultante:st,p_metadata:{fecha:date}});await refreshData({render:false});await window.openCase(cid)}catch(e){toast('No se pudo guardar',e.message)}finally{setBusy(false)}
};

function editFields(c){
  const input=(label,key,val,type='text',full=false,options=[])=>`<div class="${full?'full':''}"><label>${esc(label)}</label>${type==='textarea'?`<textarea data-patch="${esc(key)}">${esc(val||'')}</textarea>`:type==='select'?`<select data-patch="${esc(key)}">${options.map(o=>`<option ${String(o)===String(val)?'selected':''}>${esc(o)}</option>`).join('')}</select>`:`<input data-patch="${esc(key)}" type="${type}" value="${esc(val||'')}">`}</div>`;
  if(c._caseType==='alerta')return input('Nivel de riesgo','nivel_riesgo',c.riesgo,'select',false,['Muy alto','Alto','Medio','Bajo'])+input('Nivel de prioridad','nivel_prioridad',c.nivel)+input('Comentario inicial','comentario_inicial',c.comentario,'textarea',true)+input('Detalle de alerta','detalle_alerta',c.detalle,'textarea',true);
  if(c._caseType==='orientacion')return input('Fecha','fecha_orientacion',c.fecha,'date')+input('Modalidad','modalidad',c.modalidad)+input('Tipo de orientación','tipo_orientacion',c.tipoAtencion)+input('Responsable','responsable',c.responsable)+input('Motivo','motivo',c.motivo,'textarea',true)+input('Detalle','detalle',c.detalle,'textarea',true)+input('Estado','estado',c.estado,'select',false,['En seguimiento','Cerrado'])+input('Resultado de cierre','resultado_cierre',c.resultadoCierre);
  return input('Fecha de conocimiento','fecha_conocimiento',c.fecha,'date')+input('Tipo de riesgo','tipo_riesgo',c.riesgoSocial||c.protocolo)+input('Detalle del caso','detalle',c.detalle,'textarea',true)+input('Orientación brindada','orientacion',c.orientacion,'textarea',true)+input('¿Corresponde oficio?','corresponde_oficio',c.oficio==='Sí'?'true':'false','select',false,['false','true'])+input('Fecha del oficio','fecha_oficio',c.fechaOficio,'date')+input('Número de oficio','numero_oficio',c.numeroOficio)+input('Estado','estado',c.estado,'select',false,['Abierto','En seguimiento','Cerrado','Observado'])+input('Resultado de cierre','resultado_cierre',c.resultadoCierre);
}
window.openEditDeleteRequest84=function(cid){
  const c=(state.cases||[]).find(x=>x.id===cid);if(!c)return;
  $('modalTitle').textContent=profile?.rol==='monitora'||profile?.rol==='admin'?'Editar expediente':'Solicitud administrativa';$('modalSub').textContent=`${caseTypeLabel(c._caseType)} · DNI ${c.dni}`;
  $('modalBody').innerHTML=`<div class="form-block"><div class="sigeb-remote-note">Los campos muestran la información vigente. ${profile?.rol==='succor'?'Los cambios serán enviados al Administrador para su validación.':'La edición se aplicará directamente y quedará registrada en el historial.'}</div><div><label>Acción</label><select id="remoteReqType" onchange="document.getElementById('remoteEditFields').classList.toggle('hidden',this.value==='eliminacion')"><option value="edicion">Editar caso</option><option value="eliminacion">Solicitar eliminación</option></select></div><div id="remoteEditFields" class="sigeb-remote-edit-grid">${editFields(c)}</div><div style="margin-top:12px"><label>Motivo del cambio</label><textarea id="remoteEditReason" placeholder="Explique la razón de la edición o eliminación"></textarea></div><button class="btn btn-primary" style="margin-top:12px" onclick="submitCaseEditRemote('${esc(cid)}')">Guardar / enviar</button></div>`;
  $('modal').classList.add('active');
};
window.submitCaseEditRemote=async function(cid){
  const c=(state.cases||[]).find(x=>x.id===cid),action=formValue('remoteReqType'),reason=formValue('remoteEditReason');if(!c||!reason)return toast('Motivo requerido','Describa el motivo.');
  try{
    setBusy(true,'Procesando solicitud...');let result;
    if(action==='eliminacion')result=await rpc('sigeb_eliminar_caso',{p_case_type:c._caseType,p_case_id:cid,p_motivo:reason});
    else{const patch={};document.querySelectorAll('[data-patch]').forEach(el=>{patch[el.dataset.patch]=el.value});result=await rpc('sigeb_aplicar_patch',{p_case_type:c._caseType,p_case_id:cid,p_patch:patch,p_motivo:reason});}
    await refreshData();$('modal')?.classList.remove('active');toast(result?.modo==='solicitud'?'Solicitud enviada':'Cambio aplicado',result?.modo==='solicitud'?'El Administrador revisará el cambio.':'El expediente fue actualizado.');
  }catch(e){toast('No se pudo procesar',e.message)}finally{setBusy(false)}
};
window.sendReq84=()=>{};
window.deleteCase=async function(cid){const c=(state.cases||[]).find(x=>x.id===cid);if(!c)return;if(!confirm('¿Confirmar la eliminación del caso?'))return;try{setBusy(true,'Eliminando caso...');await rpc('sigeb_eliminar_caso',{p_case_type:c._caseType,p_case_id:cid,p_motivo:'Eliminación confirmada desde SIGEB'});await refreshData();$('modal')?.classList.remove('active');toast('Caso eliminado','El registro fue retirado de las vistas activas.')}catch(e){toast('No se pudo eliminar',e.message)}finally{setBusy(false)}};
window.requestDeleteCase=cid=>window.openEditDeleteRequest84(cid);
window.changeState=async function(cid,estado){const c=(state.cases||[]).find(x=>x.id===cid);if(!c)return;try{await rpc('sigeb_aplicar_patch',{p_case_type:c._caseType,p_case_id:cid,p_patch:{estado},p_motivo:'Cambio de estado'});await refreshData()}catch(e){toast('No se pudo cambiar el estado',e.message)}};

function normalizeHeader(v){return norm(v).replace(/[^a-z0-9]+/g,'_').replace(/^_|_$/g,'')}
async function readRows(file){
  if(!window.XLSX)throw new Error('No se pudo cargar el lector de archivos Excel.');
  const data=await file.arrayBuffer();const book=XLSX.read(data,{type:'array',cellDates:true});const sheet=book.Sheets[book.SheetNames[0]];
  const matrix=XLSX.utils.sheet_to_json(sheet,{header:1,defval:'',raw:false});
  const headerIndex=matrix.findIndex(row=>row.filter(v=>String(v).trim()).length>=4&&row.some(v=>norm(v)==='dni'));
  if(headerIndex<0)throw new Error('No se encontró una fila de encabezados válida.');
  const used={};const headers=matrix[headerIndex].map(v=>{let k=normalizeHeader(v)||'columna';used[k]=(used[k]||0)+1;return used[k]>1?k+'_'+(used[k]-1):k});
  return matrix.slice(headerIndex+1).filter(row=>row.some(v=>String(v).trim())).map(row=>{const o={};headers.forEach((h,i)=>o[h]=String(row[i]??'').trim());const candidates=[o.dni_1,o.dni,o.documento,o.numero_de_dni].map(cleanDni);o.dni=candidates.find(x=>/^\d{8}$/.test(x)&&x!=='00000000')||'';return o}).filter(r=>r.dni);
}
window.processIESV92=async function(){
  const file=$('v92IESFile')?.files?.[0];if(!file)return toast('Archivo requerido','Seleccione el formato reportado por la IES.');
  try{
    setBusy(true,'Procesando formato IES...');const rows=await readRows(file);
    if(!rows.length)throw new Error('El archivo no contiene filas válidas.');
    const cfg=resolveConfig();let storagePath='';
    if(file.size<=2097152){storagePath=`${activeSession.user.id}/cargas_ies/${crypto.randomUUID()}-${file.name.replace(/[^a-zA-Z0-9._-]+/g,'_')}`;const {error}=await ensureClient().storage.from(cfg.bucket).upload(storagePath,file,{contentType:file.type||'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});if(error)storagePath='';}
    const result=await rpc('sigeb_procesar_carga_ies',{p_storage_path:storagePath,p_file_name:file.name,p_rows:rows});
    await refreshData();const box=$('v92IESResult');if(box){box.classList.remove('hidden');box.innerHTML=`Se procesaron <b>${result.total}</b> filas: ${result.validas} enviadas a validación y ${result.observadas} observadas.`}toast('Carga enviada',`${result.validas} casos requieren validación de monitora.`);
  }catch(e){toast('No se pudo procesar',e.message)}finally{setBusy(false)}
};
window.processMass=async function(){
  const file=$('massFile')?.files?.[0];if(!file)return toast('Archivo requerido','Seleccione un Excel o CSV.');
  try{
    setBusy(true,'Procesando carga grupal...');const rows=await readRows(file);let ok=0,fail=0;
    for(const row of rows){try{const type=caseTypeDb(state.intervention);const payload={case_type:type,dni:row.dni,fecha:row.fecha||row.fecha_de_conocimiento||new Date().toISOString().slice(0,10),responsable:profile.nombre,detalle:row.detalle||row.comentario_inicial||'Registro grupal',modalidad:row.modalidad||'Virtual',tipo_orientacion:row.tipo_orientacion||'Individual',motivo:row.motivo||'Registro grupal',tipo_riesgo:row.tipo_riesgo||'Otro riesgo social',nivel_riesgo:normalizeRisk(row.nivel_de_riesgo||row.nivel_riesgo||'Alto'),nivel_prioridad:row.nivel_de_prioridad||'Prioridad Alta',prioridad:'Alta',tipo_alerta:'Riesgo académico'};if(type==='alerta'&&profile.rol!=='admin')await crearSolicitudCargaAlertaRemote(payload);else await rpc('sigeb_crear_caso',{p_payload:payload});ok++}catch(e){console.warn(e);fail++}}
    await refreshData();toast('Carga procesada',`${ok} registros procesados y ${fail} observados.`);
  }catch(e){toast('No se pudo procesar',e.message)}finally{setBusy(false)}
};

window.openIESValidationDetail=async function(requestId){
  const req=(state.solicitudes||[]).find(s=>s.id===requestId),cargaId=req?.metadata?.carga_id;if(!req||!cargaId)return toast('Detalle no disponible','La solicitud no contiene una carga asociada.');
  try{
    setBusy(true,'Cargando detalle IES...');const data=await rpc('sigeb_obtener_carga_ies',{p_carga_id:cargaId});const rows=data.detalle||[];
    $('modalTitle').textContent='Validación de información reportada por IES';$('modalSub').textContent=`${rows.length} caso(s) incluidos en la carga`;
    $('modalBody').innerHTML=`<div class="sigeb-remote-note">Revise la información antes de decidir. La aprobación actualizará únicamente los casos asignados a su usuario y cambiará su estado a <b>Finalizó Atención</b>.</div><div class="table-box"><div class="table-scroll"><table><thead><tr><th>DNI</th><th>Beneficiario</th><th>IES</th><th>Acciones IES</th><th>Resultado</th><th>Estado académico</th><th>Cierre IES</th><th>Observaciones</th></tr></thead><tbody>${rows.map(r=>{const d=r.datos_reportados||{};return `<tr><td><span class="dni">${esc(r.dni)}</span></td><td>${esc(r.beneficiario||'—')}</td><td>${esc(r.ies||'—')}</td><td>${esc(d.acciones_tomas_por_las_ies||d.acciones_tomadas_por_las_ies||d.acciones_ies||'—')}</td><td>${esc(d.resultado_de_las_acciones||d.resultado_acciones||'—')}</td><td>${esc(d.estado_academico||'—')}</td><td>${esc(d.caso_cerrado_por_la_ies||'—')}</td><td>${esc(d.observaciones||'—')}</td></tr>`}).join('')}</tbody></table></div></div><div style="margin-top:12px"><label>Respuesta u observación</label><textarea id="remoteIESDecisionText" placeholder="Registre la conformidad u observación"></textarea><div class="row-actions" style="margin-top:10px"><button class="btn btn-green" onclick="resolveIESRequestRemote('${esc(requestId)}',true)">Validar y finalizar</button><button class="btn btn-red" onclick="resolveIESRequestRemote('${esc(requestId)}',false)">Observar</button></div></div>`;
    $('modal').classList.add('active');
  }catch(e){toast('No se pudo cargar',e.message)}finally{setBusy(false)}
};
window.resolveIESRequestRemote=async function(id,approve){try{setBusy(true,'Procesando decisión...');await rpc('sigeb_resolver_solicitud',{p_solicitud_id:id,p_decision:approve?'aprobar':'rechazar',p_respuesta:formValue('remoteIESDecisionText')||(approve?'Información validada por la monitora.':'Información observada por la monitora.')});await refreshData();$('modal')?.classList.remove('active');toast(approve?'Validación completada':'Carga observada',approve?'Los casos validados finalizaron atención.':'La carga fue devuelta para revisión.')}catch(e){toast('No se pudo resolver',e.message)}finally{setBusy(false)}};
window.validarIESV92=(id,approve)=>approve?window.openIESValidationDetail(id):window.resolveIESRequestRemote(id,false);

window.takeRequestV79=async function(id){try{setBusy(true,'Actualizando solicitud...');const {error}=await ensureClient().from('solicitudes_admin').update({estado:'En revisión'}).eq('id',id);if(error)throw error;await refreshData();toast('Solicitud en revisión','La solicitud fue tomada en cuenta.')}catch(e){toast('No se pudo actualizar',e.message)}finally{setBusy(false)}};
window.attendRequestV79=async function(id){const response=prompt('Respuesta de atención (opcional):','Solicitud aprobada.');try{setBusy(true,'Atendiendo solicitud...');await rpc('sigeb_resolver_solicitud',{p_solicitud_id:id,p_decision:'aprobar',p_respuesta:response||'Solicitud aprobada.'});await refreshData();toast('Solicitud atendida','La decisión fue aplicada.')}catch(e){toast('No se pudo atender',e.message)}finally{setBusy(false)}};
window.rejectRequestV79=async function(id){const response=prompt('Indique el motivo del rechazo:','');if(response===null)return;try{setBusy(true,'Rechazando solicitud...');await rpc('sigeb_resolver_solicitud',{p_solicitud_id:id,p_decision:'rechazar',p_respuesta:response||'Solicitud rechazada.'});await refreshData();toast('Solicitud rechazada','La persona solicitante fue notificada.')}catch(e){toast('No se pudo rechazar',e.message)}finally{setBusy(false)}};

function requestTypeText(s){const m={validacion_ies:'Validación IES',edicion:'Edición',eliminacion:'Eliminación',carga_alerta:'Ingreso de Alerta Académica'};return m[s.tipo]||s.tipo}
function requestDetail(s){
  if(s.tipo==='validacion_ies')return `Carga IES · ${esc(s.metadata?.total||0)} caso(s)`;
  if(s.tipo==='edicion')return `Campos: ${esc(s.campos||'—')}<br><small>${esc(s.motivo)}</small>`;
  return esc(s.motivo||'—');
}
function requestAction(s){
  if(profile?.rol==='monitora'&&s.tipo==='validacion_ies'&&/pendiente|revisi[oó]n/i.test(s.estado))return `<button class="btn btn-primary btn-small" onclick="openIESValidationDetail('${esc(s.id)}')">Revisar y decidir</button>`;
  if(profile?.rol==='admin'&&/pendiente|revisi[oó]n|observado/i.test(s.estado))return `<div class="row-actions">${s.estado!=='En revisión'?`<button class="btn btn-soft btn-small" onclick="takeRequestV79('${esc(s.id)}')">Tomar</button>`:''}<button class="btn btn-green btn-small" onclick="attendRequestV79('${esc(s.id)}')">Aprobar</button><button class="btn btn-red btn-small" onclick="rejectRequestV79('${esc(s.id)}')">Rechazar</button></div>`;
  return esc(s.respuesta||'—');
}
function visibleRemoteRequests(){
  const all=state.solicitudes||[];if(profile?.rol==='admin')return all.filter(s=>s.tipo!=='validacion_ies');if(profile?.rol==='monitora')return all.filter(s=>s.tipo==='validacion_ies');return all.filter(s=>s.solicitanteRol==='succor'||s.solicitante===profile?.nombre);
}
function renderSolicitudesRemote(){
  const mount=$('solicitudesMount');if(!mount||!profile)return;const rows=visibleRemoteRequests();
  const title=$('viewSolicitudes')?.querySelector('h3');if(title)title.textContent=profile.rol==='admin'?'Recepción de solicitudes':profile.rol==='monitora'?'Validaciones pendientes':'Mis solicitudes';
  mount.innerHTML=`<div class="kpi-grid" style="grid-template-columns:repeat(3,minmax(0,1fr));margin-bottom:12px"><div class="kpi"><b>Pendientes</b><span>${rows.filter(s=>/pendiente|revisi[oó]n/i.test(s.estado)).length}</span><small>requieren acción</small></div><div class="kpi"><b>Atendidas</b><span>${rows.filter(s=>/atendido|aprobado/i.test(s.estado)).length}</span><small>gestión finalizada</small></div><div class="kpi"><b>Observadas</b><span>${rows.filter(s=>/observado|rechazado/i.test(s.estado)).length}</span><small>requieren revisión</small></div></div><div class="table-box"><div class="table-scroll"><table><thead><tr><th>Tipo</th><th>DNI</th><th>Beneficiario</th><th>Detalle</th><th>Solicitante</th><th>Fecha</th><th>Estado</th><th>Acción / respuesta</th></tr></thead><tbody>${rows.map(s=>`<tr><td>${esc(requestTypeText(s))}</td><td><span class="dni">${esc(s.dni||'—')}</span></td><td>${esc(s.beneficiario||'—')}</td><td style="min-width:280px">${requestDetail(s)}</td><td>${esc(s.solicitante||'—')}</td><td>${esc(s.fecha||'—')}</td><td><span class="v92-request-badge">${esc(s.estado)}</span></td><td>${requestAction(s)}</td></tr>`).join('')||'<tr><td colspan="8">No hay solicitudes visibles.</td></tr>'}</tbody></table></div></div>`;
  const btn=$('sideSolicitudesBtn');if(btn){const pending=rows.filter(s=>/pendiente|revisi[oó]n/i.test(s.estado)).length;btn.classList.remove('hidden');btn.style.display='grid';const strong=btn.querySelector('strong');if(strong)strong.textContent=`Solicitudes (${pending})`}
}
window.renderSolicitudes=renderSolicitudesRemote;

async function markNotification(id){try{await rpc('sigeb_marcar_notificacion',{p_id:id,p_leida:true});const n=(state.notifications||[]).find(x=>x.id===id);if(n)n.read=true;renderNotificationsRemote()}catch(e){console.error(e)}}
function renderNotificationsRemote(){
  const list=$('sigebNotifyList'),badge=$('sigebNotifyBadge');if(!list||!badge)return;const ns=state.notifications||[],unread=ns.filter(n=>!n.read).length;badge.textContent=unread;badge.classList.toggle('empty',unread===0);
  list.innerHTML=ns.length?ns.map(n=>`<button type="button" class="sigeb-notify-item ${n.read?'':'unread'}" data-remote-notif="${esc(n.id)}"><b>${esc(n.title)}</b><span>${esc(n.message)}</span><small>${esc(n.date)}</small></button>`).join(''):'<div class="sigeb-notify-empty">No hay notificaciones para este perfil.</div>';
  list.querySelectorAll('[data-remote-notif]').forEach(el=>el.onclick=async()=>{const n=ns.find(x=>String(x.id)===String(el.dataset.remoteNotif));if(!n)return;await markNotification(n.id);$('sigebNotifyPanel')?.classList.remove('active');if(n.caseId){const c=(state.cases||[]).find(x=>x.id===n.caseId);if(c)window.openCase(c.id)}else if(n.eventType==='solicitud')showView('solicitudes')});
  const mark=$('sigebMarkAll');if(mark)mark.onclick=async()=>{await Promise.all(ns.filter(n=>!n.read).map(n=>rpc('sigeb_marcar_notificacion',{p_id:n.id,p_leida:true}).catch(()=>null)));ns.forEach(n=>n.read=true);renderNotificationsRemote()};
}
window.syncNotificationsV92=renderNotificationsRemote;

function monitorOptions(){return (bootstrap?.monitoras||[]).map(m=>`<option value="${esc(m.user_id)}">${esc(m.nombre)}</option>`).join('')}
function renderAdminDistributionRemote(){
  const panel=$('adminDistributionPanel');if(!panel||!profile)return;panel.classList.toggle('hidden',profile.rol!=='admin');if(profile.rol!=='admin')return;
  const summary=$('assignSummary');if(summary){const rawTotal=remoteDistribution.reduce((a,b)=>a+Number(b.casos||0),0);summary.innerHTML=`<div class="v92-distribution-summary"><table><thead><tr><th>Monitora</th><th>Casos asignados</th><th>%</th></tr></thead><tbody>${remoteDistribution.map(r=>`<tr><td>${esc(r.monitora)}</td><td>${Number(r.casos||0)}</td><td>${Number(r.porcentaje||0).toFixed(2)}%</td></tr>`).join('')}<tr class="sigeb-total-row"><td>Total</td><td>${rawTotal}</td><td>${rawTotal?100:0}%</td></tr></tbody></table></div>`}
  const select=$('assignMonitor');if(select&&select.dataset.remote!=='1'){select.innerHTML=monitorOptions();select.dataset.remote='1'}
  let rows=(state.cases||[]).filter(c=>c._caseType==='alerta');const reg=$('assignRegion')?.value||'',st=$('assignState')?.value||'';if(reg)rows=rows.filter(c=>String(c.region_id)===reg||c.region===reg);if(st==='sin')rows=rows.filter(c=>!c.monitoraUserId);if(st==='asignado')rows=rows.filter(c=>c.monitoraUserId);
  if($('assignRows'))$('assignRows').innerHTML=rows.map(c=>`<tr><td class="select-cell"><input class="assignCheck" type="checkbox" value="${esc(c.id)}"></td><td><span class="dni">${esc(c.dni)}</span></td><td>${esc(c.beneficiario)}</td><td>${esc(c.region)}</td><td>${esc(c.ies)}</td><td>${esc(c.nivel||'—')}</td><td>${typeof statusBadge==='function'?statusBadge(c.estado):esc(c.estado)}</td><td>${esc(c.monitora||'Sin asignar')}</td><td><button class="btn btn-primary btn-small" onclick="assignOneAlert('${esc(c.id)}')">Asignar</button></td></tr>`).join('')||'<tr><td colspan="9">No hay alertas para distribuir.</td></tr>';
}
window.renderAdminDistribution=renderAdminDistributionRemote;
window.assignSelectedAlerts=async function(){const ids=[...document.querySelectorAll('.assignCheck:checked')].map(x=>x.value),monitor=$('assignMonitor')?.value;if(!ids.length||!monitor)return toast('Selección requerida','Seleccione casos y monitora.');try{setBusy(true,'Asignando alertas...');const r=await rpc('sigeb_asignar_alertas',{p_alerta_ids:ids,p_monitora_user_id:monitor});await refreshData();toast('Distribución actualizada',`${r.asignadas} casos asignados a ${r.monitora}.`)}catch(e){toast('No se pudo asignar',e.message)}finally{setBusy(false)}};
window.assignOneAlert=async id=>{document.querySelectorAll('.assignCheck').forEach(x=>x.checked=x.value===id);return window.assignSelectedAlerts()};

window.downloadConsolidado=async function(){
  const rows=typeof filteredConsolidado==='function'?filteredConsolidado():(state.cases||[]);try{if(profile?.rol==='succor'){const ids=rows.filter(c=>c._caseType==='alerta').map(c=>c.id);if(ids.length)await rpc('sigeb_marcar_alertas_conocidas',{p_ids:ids})}}
  catch(e){console.warn(e)}
  const out=[['Módulo','DNI','Beneficiario','Región','IES','Carrera','Estado','Fecha de conocimiento','Responsable','Monitora','Detalle'],...rows.map(c=>[caseTypeLabel(c._caseType),c.dni,c.beneficiario,c.region,c.ies,c.carrera,c.estado,c.fechaConocimiento,c.responsable,c.monitora,c.detalle])];downloadFile(csv(out),'consolidado_sigeb.csv');scheduleRefresh();
};

window.quickSearchBeneficiary=async function(){
  const q=formValue('topSearch');if(!q)return toast('Búsqueda vacía','Ingrese un DNI o nombre.');
  try{
    setBusy(true,'Buscando beneficiario...');const rows=await rpc('sigeb_buscar_beneficiarios',{p_texto:q,p_limit:20});
    if(!rows?.length)throw new Error('No se encontraron coincidencias en su ámbito.');rows.forEach(cacheBeneficiary);
    if(rows.length===1){const b=cacheBeneficiary(rows[0]);showView('historial');$('histDni').value=b.dni;await window.renderHistorialBecario();return}
    $('modalTitle').textContent='Resultados de búsqueda';$('modalSub').textContent=`${rows.length} coincidencias`;$('modalBody').innerHTML=`<div class="sigeb-search-results">${rows.map(r=>{const b=normalizeBeneficiary(r);return `<button onclick="selectBeneficiaryRemote('${esc(b.dni)}')"><b>${esc(b.nombre)}</b><span>DNI ${esc(b.dni)} · ${esc(b.region)} · ${esc(b.ies)}</span></button>`}).join('')}</div>`;$('modal').classList.add('active');
  }catch(e){toast('Búsqueda sin resultado',e.message)}finally{setBusy(false)}
};
window.selectBeneficiaryRemote=async dni=>{$('modal')?.classList.remove('active');showView('historial');$('histDni').value=dni;await window.renderHistorialBecario()};
window.renderHistorialBecario=async function(){
  const dni=cleanDni(formValue('histDni'));if(!/^\d{8}$/.test(dni))return toast('DNI inválido','Ingrese ocho números.');
  try{if(!beneficiaryCache.has(dni)){const b=await rpc('sigeb_buscar_becario',{p_dni:dni});if(b)cacheBeneficiary(b)}if(typeof uiRenderHistorial==='function')uiRenderHistorial()}catch(e){$('historialMount').innerHTML='<div class="notice">'+esc(e.message)+'</div>'}
};

const oldRenderAllRemote=window.renderAll;
window.renderAll=function(){
  const r=typeof oldRenderAllRemote==='function'?oldRenderAllRemote.apply(this,arguments):undefined;
  setTimeout(()=>{renderSolicitudesRemote();renderNotificationsRemote();renderAdminDistributionRemote();},80);return r;
};

function productionCleanup(){
  document.querySelectorAll('.siben-actions button[onclick*="setRole"],.siben-actions button[onclick*="resetDemo"],[onclick*="seedDemo"],[onclick*="seedAdmin"],[onclick*="seedSolicitud"],button[onclick*="Cargar casos demo"]').forEach(el=>el.remove());
  document.querySelectorAll('.v83-password-note,.v83-account-grid').forEach(el=>el.remove());
  const foot=document.querySelector('.v83-brand-foot');if(foot)foot.textContent='Acceso institucional · Programa Nacional de Becas y Crédito Educativo';
}

async function init(){productionCleanup();await sleep(20);await initAuth()}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})();
