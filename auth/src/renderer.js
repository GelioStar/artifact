// auth renderer.js (окно авторизации)
(function(){
  const $ = (id)=>document.getElementById(id);
  const registerCard = $('registerCard');
  const loginCard = $('loginCard');
  const profileCard = $('profileCard');
  const registerBtn = $('registerBtn');
  const loginBtn = $('loginBtn');
  const logoutBtn = $('logoutBtn');
  const showLogin = $('showLogin');
  const showRegister = $('showRegister');
  const regMsg = $('regMsg');
  const logMsg = $('logMsg');
  const profileInfo = $('profileInfo');

  function showMsg(el, text, ok=true){
    el.style.color = ok ? '#007700' : '#b00020';
    el.textContent = text;
  }

  function showProfile(user){
    if(!user){ profileCard.style.display='none'; return; }
    profileCard.style.display='block';
    registerCard.style.display='none';
    loginCard.style.display='none';
    profileInfo.innerHTML = `<div><strong>${user.username}</strong></div><div>${user.email || ''}</div><div>Joined: ${user.created_at}</div>`;
  }

  showLogin.addEventListener('click', ()=>{ registerCard.style.display='none'; loginCard.style.display='block'; regMsg.textContent=''; });
  showRegister.addEventListener('click', ()=>{ loginCard.style.display='none'; registerCard.style.display='block'; logMsg.textContent=''; });

  registerBtn.addEventListener('click', async ()=>{
    const username = $('regUsername').value.trim();
    const email = $('regEmail').value.trim();
    const password = $('regPassword').value;
    const confirm = $('regConfirm').value;

    if(!username || !password){ showMsg(regMsg, 'Имя пользователя и пароль', false); return; }
    if(password !== confirm){ showMsg(regMsg, 'Пароли не совпадают', false); return; }

    registerBtn.disabled = true;
    showMsg(regMsg, 'Проходим регистрацию...', true);

    try {
      const res = await window.auth.register({ username, email, password });
      if(res.success){
        // сохраняем токен в localStorage (удобно для восстановления), а также в main SessionStore via bridge
        localStorage.setItem('sessionToken', res.token);
        showMsg(regMsg, 'Поздравляем! Добро пожаловать!', true);
        showProfile(res.user);
        if (window.bridge && typeof window.bridge.authenticated === 'function') {
          // передаём объект { token, user } — main сохранит в SessionStore
          await window.bridge.authenticated({ token: res.token, user: res.user });
        }
      } else {
        showMsg(regMsg, res.error || 'Регистрация отклонена.', false);
      }
    } catch (err) {
      console.error(err);
      showMsg(regMsg, 'Сервер временно недоступен. Повторите попытку позже.', false);
    } finally { registerBtn.disabled = false; }
  });

  loginBtn.addEventListener('click', async ()=>{
    const username = $('logUsername').value.trim();
    const password = $('logPassword').value;
    if(!username || !password){ showMsg(logMsg, 'Требуется ввести имя пользователя и(или) пароль.', false); return; }
    loginBtn.disabled = true;
    showMsg(logMsg, 'Входим в систему...', true);
    try {
      const res = await window.auth.login({ username, password });
      if(res.success){
        localStorage.setItem('sessionToken', res.token);
        showMsg(logMsg, 'Поздравляем! Добро пожаловать!', true);
        showProfile(res.user);
        if (window.bridge && typeof window.bridge.authenticated === 'function') {
          await window.bridge.authenticated({ token: res.token, user: res.user });
        }
      } else {
        showMsg(logMsg, res.error || 'Вход отклонен.', false);
      }
    } catch (err) {
      console.error(err);
      showMsg(logMsg, 'Сервер временно недоступен. Повторите попытку позже.', false);
    } finally { loginBtn.disabled = false; }
  });

  logoutBtn.addEventListener('click', async ()=>{
    const token = localStorage.getItem('sessionToken');
    try {
      await window.auth.logout(token);
    } catch (e) { /* ignore errors */ }
    localStorage.removeItem('sessionToken');
    profileCard.style.display = 'none';
    loginCard.style.display = 'block';
    showMsg(regMsg, 'Logged out', true);
    if (window.bridge && typeof window.bridge.logoutNotify === 'function') {
      await window.bridge.logoutNotify();
    }
  });

  (async function restore(){
    const token = localStorage.getItem('sessionToken');
    if(!token) return;
    try {
      const res = await window.auth.getUser(token);
      if(res.success && res.user){
        showProfile(res.user);
        // При восстановлении передаём в main process сам токен и user
        if (window.bridge && typeof window.bridge.authenticated === 'function') {
          await window.bridge.authenticated({ token, user: res.user });
        }
      } else {
        localStorage.removeItem('sessionToken');
      }
    } catch(e){
      console.error(e);
    }
  })();
})();
