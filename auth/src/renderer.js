// renderer.js - front-end logic using window.auth (preload)
//
// Подробные комментарии ориентированы на начинающего JavaScript-программиста
// (еще не джуна): объясняют, что делает каждый блок, почему это сделано так
// и на что обращать внимание при доработке/отладке.

(function(){
  // Небольшая "мини-библиотека" — удобная функция для частого действия
  // Возвращает элемент по id — короче чем писать document.getElementById каждый раз
  // Почему стрелочная функция: компактная запись, не используется this.
  const $ = (id)=>document.getElementById(id);

  // -----------------------------
  // Forms and elements
  // -----------------------------
  // Здесь мы получаем ссылки на элементы DOM, с которыми будем работать.
  // Сохраняем их в переменные для удобства и чтобы не делать повторный поиск в DOM.
  // Пример: registerCard — карточка (div/form) регистрации, registerBtn — кнопка.
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

  // -----------------------------
  // Helpers (вспомогательные функции)
  // -----------------------------
  // showMsg — одно место, где мы показываем пользователю сообщение об ошибке/успехе.
  // Это удобно: поддерживаем единый стиль (цвет), легко менять поведение.
  function showMsg(el, text, ok=true){
    // el: DOM-элемент (span/div), text: строка, ok: true — успех, false — ошибка
    // Меняем цвет текста в зависимости от результата: зелёный для успеха, красный для ошибки
    el.style.color = ok ? '#007700' : '#b00020';
    // textContent — безопаснее innerHTML, потому что не парсит HTML и не даёт XSS
    el.textContent = text;
  }

  // showProfile — показывает карточку профиля и скрывает формы входа/регистрации
  // Принимает user — объект с данными пользователя. Если user отсутствует, скрываем профиль.
  function showProfile(user){
    if(!user){ profileCard.style.display='none'; return; }
    // Отображаем профиль и скрываем остальные формы. Это простая логика переключения вида.
    profileCard.style.display='block';
    registerCard.style.display='none';
    loginCard.style.display='none';
    // profileInfo — контейнер, куда вставляем базовую информацию о пользователе.
    // Мы используем шаблонные строки (``) для удобной вставки переменных.
    // Обратите внимание: здесь мы напрямую вставляем значения user.username/user.email.
    // В реальном приложении стоит убедиться, что эти поля безопасны (экранировать при необходимости),
    // но в простом клиенте для демонстрации это обычно допустимо.
    profileInfo.innerHTML = `<div><strong>${user.username}</strong></div><div>${user.email || ''}</div><div>Joined: ${user.created_at}</div>`;
  }

  // -----------------------------
  // Toggle views — переключение видимости форм
  // -----------------------------
  // Когда пользователь кликает "Зарегистрироваться" или "Войти",
  // показываем соответствующую карточку и очищаем сообщения об ошибках.
  showLogin.addEventListener('click', ()=>{ registerCard.style.display='none'; loginCard.style.display='block'; regMsg.textContent=''; });
  showRegister.addEventListener('click', ()=>{ loginCard.style.display='none'; registerCard.style.display='block'; logMsg.textContent=''; });

  // -----------------------------
  // Register action — логика регистрации
  // -----------------------------
  // Обратите внимание: код не меняет саму логику, но подробно расписаны этапы
  registerBtn.addEventListener('click', async ()=>{
    // Получаем значения из полей формы. .value всегда возвращает строку.
    // Для username и email делаем trim() — убираем пробелы в начале и конце,
    // чтобы пользователь случайно не отправил "имя " и получил неожиданные ошибки.
    const username = $('regUsername').value.trim();
    const email = $('regEmail').value.trim();
    const password = $('regPassword').value;
    const confirm = $('regConfirm').value;

    // Простая валидация на клиенте: проверяем, что введены обязательные поля
    // Это не заменяет валидацию на сервере — всегда проверяйте данные на сервере тоже.
    if(!username || !password){ showMsg(regMsg, 'Username and password required', false); return; }
    // Проверяем совпадение паролей — частая причина ошибок у пользователей
    if(password !== confirm){ showMsg(regMsg, 'Passwords do not match', false); return; }

    // Блокируем кнопку, чтобы пользователь не кликнул много раз пока идёт запрос
    registerBtn.disabled = true;
    // Показываем пользователю прогресс/состояние
    showMsg(regMsg, 'Registering...', true);

    try {
      // window.auth — API, переданное из preload (Electron). Предполагается, что
      // у него есть метод register, возвращающий объект вида { success, token, user, error }
      // await — ждём результата асинхронной операции.
      const res = await window.auth.register({ username, email, password });
      if(res.success){
        // Сохраняем токен в localStorage для простого сохранения сессии между запуском приложения
        // Замечание по безопасности: localStorage прост в использовании, но не самый безопасный
        // вариант для критичных данных — при атаке XSS токен может быть похищен.
        localStorage.setItem('sessionToken', res.token);
        showMsg(regMsg, 'Registered successfully', true);
        // Показываем профиль сразу после успешной регистрации
        showProfile(res.user);
        if (window.bridge && typeof window.bridge.authenticated === 'function') {
          window.bridge.authenticated(res.token);
        }
      } else {
        // Если сервер вернул ошибку, показываем её. res.error может быть строкой от API.
        showMsg(regMsg, res.error || 'Registration failed', false);
      }
    } catch (err) {
      // Отлавливаем неожиданные ошибки (сеть, баг в API и т.п.)
      console.error(err);
      showMsg(regMsg, 'Unexpected error', false);
    } finally { registerBtn.disabled = false; }
  });

  // -----------------------------
  // Login action — авторизация
  // -----------------------------
  // Схожая логика с регистрацией: валидация -> блокировка кнопки -> вызов API -> обработка ответа
  loginBtn.addEventListener('click', async ()=>{
    const username = $('logUsername').value.trim();
    const password = $('logPassword').value;
    if(!username || !password){ showMsg(logMsg, 'Username and password required', false); return; }
    loginBtn.disabled = true;
    showMsg(logMsg, 'Logging in...', true);
    try {
      const res = await window.auth.login({ username, password });
      if(res.success){
        localStorage.setItem('sessionToken', res.token);
        showMsg(logMsg, 'Logged in', true);
        showProfile(res.user);
        if (window.bridge && typeof window.bridge.authenticated === 'function') {
          window.bridge.authenticated(res.token);
        }
      } else {
        showMsg(logMsg, res.error || 'Login failed', false);
      }
    } catch (err) {
      console.error(err);
      showMsg(logMsg, 'Unexpected error', false);
    } finally { loginBtn.disabled = false; }
  });

  // -----------------------------
  // Logout — выход из аккаунта
  // -----------------------------
  // Здесь мы вызываем window.auth.logout (предполагается, что он завершает сессию на стороне бэка),
  // удаляем токен из localStorage и возвращаемся к форме регистрации.
  logoutBtn.addEventListener('click', async ()=>{
    const token = localStorage.getItem('sessionToken');
    await window.auth.logout(token);
    localStorage.removeItem('sessionToken');
    profileCard.style.display = 'none';
    loginCard.style.display = 'block';
    showMsg(regMsg, 'Logged out', true);
    if (window.bridge && typeof window.bridge.logoutNotify === 'function') {
      window.bridge.logoutNotify();
    }
  });

  // -----------------------------
  // On load, try to restore session
  // -----------------------------
  // Самовызывающаяся асинхронная функция — выполняется сразу при загрузке файла.
  // Если в localStorage остался токен, пытаемся получить пользователя по этому токену
  // и восстановить интерфейс (показать профиль).
  (async function restore(){
    const token = localStorage.getItem('sessionToken');
    if(!token) return; // токена нет — ничего восстанавливать
    try {
      const res = await window.auth.getUser(token);
      if(res.success && res.user){
        // Восстанавливаем интерфейс как для авторизованного пользователя
        showProfile(res.user);
        if (window.bridge && typeof window.bridge.authenticated === 'function') {
          window.bridge.authenticated(res.token);
        }
      } else {
        // Токен недействителен или просрочен — очищаем
        localStorage.removeItem('sessionToken');
      }
    } catch(e){
      // Ошибка при запросе — логируем, но не показываем пользователю технические детали
      console.error(e);
    }
  })();
})();

document.addEventListener('dom-ready', () => {
  document.openDevTools();
});