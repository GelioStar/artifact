class Router {
    constructor(routes) {
        if (!routes) {
            throw 'error: routes param is mandatory';
        }
        this.routes = routes;
        this.rootElem = document.getElementById('app');
        this.init();
    }

    init() {
        window.addEventListener('hashchange', () => this.hasChanged());
        this.hasChanged();
    }

    hasChanged() {
        const hash = window.location.hash.substr(1);
        const matchedRoute = this.routes.find((route) => route.isActiveRoute(hash));

        if (matchedRoute) {
            this.goToRoute(matchedRoute.htmlName);
        } else {
            const defaultRoute = this.routes.find((route) => route.default);
            if (defaultRoute) {
                this.goToRoute(defaultRoute.htmlName);
            }
        }
    }

    goToRoute(htmlName) {
        const url = 'scripts/renderer/views/' + htmlName;
        fetch(url)
            .then((response) => response.text())
            .then((html) => {
                this.rootElem.innerHTML = html;
                
                // Критическое исправление: повторная инициализация скриптов и стилей
                this.reinitializeScriptsAndStyles();
            })
            .catch((error) => console.error('Error loading route:', error));
    }

    reinitializeScriptsAndStyles() {
        // 1. Переинициализация Bootstrap компонентов
        this.initializeBootstrapComponents();
        
        // 2. Выполнение inline скриптов
        this.executeInlineScripts();
        
        // 3. Повторная привязка событий
        this.bindDynamicEvents();
    }

    initializeBootstrapComponents() {
        // Инициализация Bootstrap компонентов для динамического контента
        const tooltips = document.querySelectorAll('[data-bs-toggle="tooltip"]');
        if (tooltips.length > 0 && typeof bootstrap !== 'undefined') {
            tooltips.forEach(tooltip => new bootstrap.Tooltip(tooltip));
        }

        const popovers = document.querySelectorAll('[data-bs-toggle="popover"]');
        if (popovers.length > 0 && typeof bootstrap !== 'undefined') {
            popovers.forEach(popover => new bootstrap.Popover(popover));
        }

        const modals = document.querySelectorAll('.modal');
        if (modals.length > 0 && typeof bootstrap !== 'undefined') {
            modals.forEach(modal => new bootstrap.Modal(modal));
        }
    }

    executeInlineScripts() {
        // Находим и выполняем inline скрипты в загруженном контенте
        const scripts = this.rootElem.getElementsByTagName('script');
        
        for (let i = 0; i < scripts.length; i++) {
            if (scripts[i].src) {
                // Для внешних скриптов создаем новый тег
                const newScript = document.createElement('script');
                newScript.src = scripts[i].src;
                if (scripts[i].async) newScript.async = true;
                if (scripts[i].defer) newScript.defer = true;
                document.head.appendChild(newScript);
            } else {
                // Для inline скриптов выполняем непосредственно
                try {
                    eval(scripts[i].innerHTML);
                } catch (e) {
                    console.warn('Error executing inline script:', e);
                }
            }
        }
    }

    bindDynamicEvents() {
        // Привязка событий для динамически созданных элементов
        const buttons = this.rootElem.querySelectorAll('button, a, input[type="submit"]');
        buttons.forEach(button => {
            if (!button.hasAttribute('data-event-bound')) {
                button.setAttribute('data-event-bound', 'true');
                
                // Пример: привязка клика для кнопок с определенным классом
                if (button.classList.contains('btn-primary')) {
                    button.addEventListener('click', (e) => {
                        console.log('Button clicked:', e.target.textContent);
                    });
                }
            }
        });
    }
}