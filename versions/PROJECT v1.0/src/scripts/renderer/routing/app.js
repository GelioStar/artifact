'use strict';

(function () {
    function init() {
        // Инициализация глобальных обработчиков
        initializeGlobalHandlers();
        
        var router = new Router([
            new Route('home', 'home/home.html', true),
            new Route('settings', 'settings/settings.html'),
        ]);
    }

    function initializeGlobalHandlers() {
        // Глобальная инициализация при загрузке страницы
        document.addEventListener('DOMContentLoaded', function() {
            initializePageSpecificScripts();
        });
    }

    function initializePageSpecificScripts() {
        // Инициализация скриптов в зависимости от текущей страницы
        const hash = window.location.hash.substr(1) || 'home';
        
        switch(hash) {
            case 'home':
                initializeHomePage();
                break;
            case 'settings':
                initializeAboutPage();
                break;
        }
    }

    function initializeHomePage() {
        console.log('Initializing home page scripts');
        // Добавьте специфичные для главной страницы скрипты здесь
    }

    function initializeAboutPage() {
        console.log('Initializing about page scripts');
        // Добавьте специфичные для страницы "О нас" скрипты здесь
    }

    function initializeContactPage() {
        console.log('Initializing contact page scripts');
        // Инициализация формы обратной связи
        const contactForm = document.getElementById('contact-form');
        if (contactForm) {
            contactForm.addEventListener('submit', function(e) {
                e.preventDefault();
                console.log('Contact form submitted');
                // Добавьте логику обработки формы здесь
            });
        }
    }

    function initializePortfolioPage() {
        console.log('Initializing portfolio page scripts');
        // Инициализация портфолио (например, модальные окна для проектов)
        const projectButtons = document.querySelectorAll('.portfolio-project');
        projectButtons.forEach(button => {
            button.addEventListener('click', function() {
                console.log('Project clicked:', this.dataset.projectId);
            });
        });
    }

    // Экспортируем функции для использования в роутере
    window.initializePageSpecificScripts = initializePageSpecificScripts;
    
    init();
}());