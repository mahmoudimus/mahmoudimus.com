(function() {
  var menuToggle = document.querySelector('.menu-toggle');
  var navMenu = document.querySelector('.nav-menu');
  var avatar = document.querySelector('.avatar');
  var lastScrollTop = 0;
  var scrollThreshold = 100;
  var mobileBreakpoint = 720;
  
  if (menuToggle && navMenu) {
    menuToggle.addEventListener('click', function() {
      var isExpanded = menuToggle.getAttribute('aria-expanded') === 'true';
      menuToggle.setAttribute('aria-expanded', !isExpanded);
      navMenu.classList.toggle('menu-open');
      menuToggle.classList.toggle('active');
    });
  }

  // Check if we're on mobile
  function isMobile() {
    return window.innerWidth <= mobileBreakpoint;
  }

  // Handle scroll to hide/show avatar (only on mobile)
  function handleScroll() {
    var scrollTop = window.pageYOffset || document.documentElement.scrollTop;
    
    if (avatar) {
      // Only hide avatar on mobile when scrolling
      if (isMobile() && scrollTop > scrollThreshold) {
        avatar.classList.add('hidden');
      } else {
        // Always show on desktop, or show on mobile when at top
        avatar.classList.remove('hidden');
      }
    }
    
    lastScrollTop = scrollTop;
  }

  // Throttle scroll events for better performance
  var ticking = false;
  window.addEventListener('scroll', function() {
    if (!ticking) {
      window.requestAnimationFrame(function() {
        handleScroll();
        ticking = false;
      });
      ticking = true;
    }
  });

  // Re-evaluate on window resize (e.g., when expanding browser)
  window.addEventListener('resize', function() {
    handleScroll();
  });

  // Initial check
  handleScroll();
})();

