const DEFAULT_PARTICLE_COUNT = 12;
const DEFAULT_SPOTLIGHT_RADIUS = 500;
const DEFAULT_GLOW_COLOR = "0, 102, 255";
// const DEFAULT_GLOW_COLOR = "5, 135, 196";
const MOBILE_BREAKPOINT = 768;

// Global variables
let isMobile = window.innerWidth <= MOBILE_BREAKPOINT;
let spotlightElement = null;
let isInsideSection = true;
let globalSettings = {
    enableSpotlight: true,
    enableParticles: false,
    glowColor: DEFAULT_GLOW_COLOR
};

// Initialize on DOM load
document.addEventListener('DOMContentLoaded', () => {
    initializeMagicCards();
    initializeGlobalSpotlight();
    window.addEventListener('resize', handleResize);
});

// Handle window resize
function handleResize() {
    isMobile = window.innerWidth <= MOBILE_BREAKPOINT;
}

// Initialize all magic cards
function initializeMagicCards() {
    const magicCards = document.querySelectorAll('.magic-card');
    
    magicCards.forEach((card, index) => {
        setupMagicCard(card, index);
    });
}

// Setup individual magic card
function setupMagicCard(card, _index) {
    // Get settings from data attributes or use defaults
    const glowColor = card.getAttribute('data-glow-color') || DEFAULT_GLOW_COLOR;
    // Add border glow class
    card.classList.add('magic-card--border-glow');
    // Set custom properties
    card.style.setProperty('--glow-color', glowColor);
    // Initialize particles if enabled and not on mobile
    if (globalSettings.enableParticles && !isMobile)
        setupParticleEffects(card, DEFAULT_PARTICLE_COUNT, glowColor);
    setupCardInteractivity(card, false, false, false, glowColor);
}

// Setup particle effects for a card
function setupParticleEffects(card, particleCount, glowColor) {
    const particles = [];
    const timeouts = [];
    let isHovered = false;
    let particlesInitialized = false;
    let memoizedParticles = [];
    let magnetismAnimation = null;

    // Initialize particles
    function initializeParticles() {
        if (particlesInitialized || !card) return;

        const { width, height } = card.getBoundingClientRect();
        memoizedParticles = Array.from({ length: particleCount }, () => 
            createParticleElement(
                Math.random() * width,
                Math.random() * height,
                glowColor
            )
        );
        particlesInitialized = true;
    }

    // Clear all particles
    function clearAllParticles() {
        timeouts.forEach(clearTimeout);
        timeouts.length = 0;
        
        if (magnetismAnimation) {
            magnetismAnimation.kill();
        }

        particles.forEach((particle) => {
            gsap.to(particle, {
                scale: 0,
                opacity: 0,
                duration: 0.3,
                ease: "back.in(1.7)",
                onComplete: () => {
                    if (particle.parentNode) {
                        particle.parentNode.removeChild(particle);
                    }
                },
            });
        });
        particles.length = 0;
    }

    // Animate particles
    function animateParticles() {
        if (!card || !isHovered) return;

        if (!particlesInitialized) {
            initializeParticles();
        }

        memoizedParticles.forEach((particle, idx) => {
            const timeoutId = setTimeout(() => {
                if (!isHovered || !card) return;

                const clone = particle.cloneNode(true);
                card.appendChild(clone);
                particles.push(clone);

                gsap.fromTo(
                    clone,
                    { scale: 0, opacity: 0 },
                    { scale: 1, opacity: 1, duration: 0.3, ease: "back.out(1.7)" }
                );

                gsap.to(clone, {
                    x: (Math.random() - 0.5) * 100,
                    y: (Math.random() - 0.5) * 100,
                    rotation: Math.random() * 360,
                    duration: 2 + Math.random() * 2,
                    ease: "none",
                    repeat: -1,
                    yoyo: true,
                });

                gsap.to(clone, {
                    opacity: 0.3,
                    duration: 1.5,
                    ease: "power2.inOut",
                    repeat: -1,
                    yoyo: true,
                });
            }, idx * 100);

            timeouts.push(timeoutId);
        });
    }

    // Event handlers
    function handleMouseEnter() {
        isHovered = true;
        animateParticles();
    }

    function handleMouseLeave() {
        isHovered = false;
        clearAllParticles();
    }

    // Add event listeners
    card.addEventListener("mouseenter", handleMouseEnter);
    card.addEventListener("mouseleave", handleMouseLeave);

    // Cleanup function
    card.cleanupParticleCard = function() {
        isHovered = false;
        card.removeEventListener("mouseenter", handleMouseEnter);
        card.removeEventListener("mouseleave", handleMouseLeave);
        clearAllParticles();
    };
}

// Setup card interactivity
function setupCardInteractivity(card, enableTilt, enableMagnetism, clickEffect, glowColor) {
    function handleMouseMove(e) {
        if (isMobile) return;

        const rect = card.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        const centerX = rect.width / 2;
        const centerY = rect.height / 2;

        if (enableTilt) {
            const rotateX = ((y - centerY) / centerY) * -3;
            const rotateY = ((x - centerX) / centerX) * 3;

            gsap.to(card, {
                rotateX,
                rotateY,
                duration: 0.1,
                ease: "power2.out",
                transformPerspective: 1000,
            });
        }

        if (enableMagnetism) {
            const magnetX = (x - centerX) * 0.03;
            const magnetY = (y - centerY) * 0.03;

            gsap.to(card, {
                x: magnetX,
                y: magnetY,
                duration: 0.3,
                ease: "power2.out",
            });
        }
    }

    function handleMouseLeave() {
        if (isMobile) return;

        if (enableTilt) {
            gsap.to(card, {
                rotateX: 0,
                rotateY: 0,
                duration: 0.3,
                ease: "power2.out",
            });
        }

        if (enableMagnetism) {
            gsap.to(card, {
                x: 0,
                y: 0,
                duration: 0.3,
                ease: "power2.out",
            });
        }
    }

    function handleClick(e) {
        if (!clickEffect || isMobile) return;

        const rect = card.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        const maxDistance = Math.max(
            Math.hypot(x, y),
            Math.hypot(x - rect.width, y),
            Math.hypot(x, y - rect.height),
            Math.hypot(x - rect.width, y - rect.height)
        );

        const ripple = document.createElement("div");
        ripple.style.cssText = `
            position: absolute;
            width: ${maxDistance * 2}px;
            height: ${maxDistance * 2}px;
            border-radius: 50%;
            background: radial-gradient(circle, rgba(${glowColor}, 0.4) 0%, rgba(${glowColor}, 0.2) 30%, transparent 70%);
            left: ${x - maxDistance}px;
            top: ${y - maxDistance}px;
            pointer-events: none;
            z-index: 1000;
        `;

        card.appendChild(ripple);

        gsap.fromTo(
            ripple,
            {
                scale: 0,
                opacity: 1,
            },
            {
                scale: 1,
                opacity: 0,
                duration: 0.8,
                ease: "power2.out",
                onComplete: () => {
                    if (ripple.parentNode) {
                        ripple.parentNode.removeChild(ripple);
                    }
                },
            }
        );
    }

    // Add event listeners
    card.addEventListener("mousemove", handleMouseMove);
    card.addEventListener("mouseleave", handleMouseLeave);
    card.addEventListener("click", handleClick);

    // Cleanup function
    card.cleanupInteractivity = function() {
        card.removeEventListener("mousemove", handleMouseMove);
        card.removeEventListener("mouseleave", handleMouseLeave);
        card.removeEventListener("click", handleClick);
    };
}

// Create a particle element
function createParticleElement(x, y, color = DEFAULT_GLOW_COLOR) {
    const el = document.createElement("div");
    el.className = "particle";
    el.style.cssText = `
        position: absolute;
        width: 4px;
        height: 4px;
        border-radius: 50%;
        background: rgba(${color}, 1);
        box-shadow: 0 0 6px rgba(${color}, 0.6);
        pointer-events: none;
        z-index: 100;
        left: ${x}px;
        top: ${y}px;
    `;
    return el;
}

// Calculate spotlight values
function calculateSpotlightValues(radius) {
    return {
        proximity: radius * 0.5,
        fadeDistance: radius * 0.75,
    };
}

// Update card glow properties
function updateCardGlowProperties(card, mouseX, mouseY, glow, radius) {
    const rect = card.getBoundingClientRect();
    const relativeX = ((mouseX - rect.left) / rect.width) * 100;
    const relativeY = ((mouseY - rect.top) / rect.height) * 100;

    card.style.setProperty("--glow-x", `${relativeX}%`);
    card.style.setProperty("--glow-y", `${relativeY}%`);
    card.style.setProperty("--glow-intensity", glow.toString());
    card.style.setProperty("--glow-radius", `${radius}px`);
}

// Initialize global spotlight
function initializeGlobalSpotlight() {
    if (!globalSettings.enableSpotlight || isMobile) return;

    spotlightElement = document.createElement("div");
    spotlightElement.className = "global-spotlight";
    // spotlightElement.style.background = `
    //     radial-gradient(circle,
    //     rgba(${globalSettings.glowColor}, 0.15) 0%,
    //     rgba(${globalSettings.glowColor}, 0.08) 15%,
    //     rgba(${globalSettings.glowColor}, 0.04) 25%,
    //     rgba(${globalSettings.glowColor}, 0.02) 40%,
    //     rgba(${globalSettings.glowColor}, 0.01) 65%,
    //     transparent 70%)
    // `;
    document.body.appendChild(spotlightElement);

    // Add event listeners for spotlight
    document.addEventListener("mousemove", handleGlobalMouseMove);
    document.addEventListener("mouseleave", handleGlobalMouseLeave);
}

// Handle global mouse move for spotlight
function handleGlobalMouseMove(e) {
    if (!spotlightElement) return;

    const magicCards = document.querySelectorAll('.magic-card');
    let minDistance = Infinity;

    magicCards.forEach((card) => {
        const cardRect = card.getBoundingClientRect();
        const centerX = cardRect.left + cardRect.width / 2;
        const centerY = cardRect.top + cardRect.height / 2;
        const distance =
            Math.hypot(e.clientX - centerX, e.clientY - centerY) -
            Math.max(cardRect.width, cardRect.height) / 2;
        const effectiveDistance = Math.max(0, distance);

        minDistance = Math.min(minDistance, effectiveDistance);

        const { proximity, fadeDistance } = calculateSpotlightValues(DEFAULT_SPOTLIGHT_RADIUS);
        let glowIntensity = 0;
        
        if (effectiveDistance <= proximity) {
            glowIntensity = 1;
        } else if (effectiveDistance <= fadeDistance) {
            glowIntensity = (fadeDistance - effectiveDistance) / (fadeDistance - proximity);
        }

        updateCardGlowProperties(
            card,
            e.clientX,
            e.clientY,
            glowIntensity,
            DEFAULT_SPOTLIGHT_RADIUS
        );
    });

    gsap.to(spotlightElement, {
        left: e.clientX,
        top: e.clientY,
        duration: 0.1,
        ease: "power2.out",
    });

    const { proximity, fadeDistance } = calculateSpotlightValues(DEFAULT_SPOTLIGHT_RADIUS);
    const targetOpacity =
        minDistance <= proximity
            ? 0.8
            : minDistance <= fadeDistance
                ? ((fadeDistance - minDistance) / (fadeDistance - proximity)) * 0.8
                : 0;

    gsap.to(spotlightElement, {
        opacity: targetOpacity,
        duration: targetOpacity > 0 ? 0.2 : 0.5,
        ease: "power2.out",
    });
}

// Handle global mouse leave for spotlight
function handleGlobalMouseLeave() {
    isInsideSection = false;
    document.querySelectorAll(".magic-card").forEach((card) => {
        card.style.setProperty("--glow-intensity", "0");
    });
    
    if (spotlightElement) {
        gsap.to(spotlightElement, {
            opacity: 0,
            duration: 0.3,
            ease: "power2.out",
        });
    }
}

// Cleanup function for when the page is unloaded
window.addEventListener('beforeunload', () => {
    // Cleanup cards
    document.querySelectorAll('.magic-card').forEach(card => {
        if (card.cleanupParticleCard) {
            card.cleanupParticleCard();
        }
        if (card.cleanupInteractivity) {
            card.cleanupInteractivity();
        }
    });

    // Remove global spotlight
    if (spotlightElement && spotlightElement.parentNode) {
        spotlightElement.parentNode.removeChild(spotlightElement);
    }

    // Remove global event listeners
    document.removeEventListener("mousemove", handleGlobalMouseMove);
    document.removeEventListener("mouseleave", handleGlobalMouseLeave);
    window.removeEventListener('resize', handleResize);
});