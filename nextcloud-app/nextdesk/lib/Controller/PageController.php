<?php

declare(strict_types=1);

namespace OCA\Nextdesk\Controller;

use OCP\AppFramework\Controller;
use OCP\AppFramework\Http\ContentSecurityPolicy;
use OCP\AppFramework\Http\FeaturePolicy;
use OCP\AppFramework\Http\TemplateResponse;
use OCP\IConfig;
use OCP\IRequest;
use OCP\IURLGenerator;

class PageController extends Controller {
    public function __construct(
        string $appName,
        IRequest $request,
        private IConfig $config,
        private IURLGenerator $urlGenerator,
    ) {
        parent::__construct($appName, $request);
    }

    /**
     * @NoAdminRequired
     * @NoCSRFRequired
     */
    public function index(): TemplateResponse {
        $url = rtrim((string) $this->config->getAppValue($this->appName, 'url', ''), '/');
        $response = new TemplateResponse($this->appName, 'index', [
            'url' => $url,
            'logoUrl' => $this->urlGenerator->imagePath($this->appName, 'app.png'),
        ]);

        // Nextcloud's own CSP must explicitly allow embedding Nextdesk's
        // origin — 'self' alone (the default) only covers same-origin
        // iframes. This is one half of the embedding handshake; the other
        // half (Nextdesk's nginx allowing *this* Nextcloud's origin to frame
        // it — X-Frame-Options/frame-ancestors) lives on the Nextdesk side,
        // see this app's README.
        //
        // Start from the policy TemplateResponse already attached (its
        // normal default-src/script-src/etc. 'self' allowances for
        // Nextcloud's own core assets) rather than a fresh, empty
        // ContentSecurityPolicy — replacing it outright rather than
        // extending it blocked Nextcloud's own JS from loading on this page
        // entirely (default-src 'none').
        $csp = $response->getContentSecurityPolicy() ?? new ContentSecurityPolicy();
        $origin = $this->originOf($url);
        if ($origin !== null) {
            $csp->addAllowedFrameDomain($origin);
        }
        $response->setContentSecurityPolicy($csp);

        // Nextcloud's default Feature-Policy restricts fullscreen to 'self',
        // which blocks the Fullscreen API for Nextdesk's iframe (cross-origin)
        // regardless of the iframe's own allow="fullscreen" attribute — a
        // Feature-Policy header from an ancestor document can only restrict,
        // never be re-granted by a child. FeaturePolicy already defaults
        // fullscreen/autoplay to 'self', so just add Nextdesk's origin too.
        $featurePolicy = $response->getFeaturePolicy() ?? new FeaturePolicy();
        if ($origin !== null) {
            $featurePolicy->addAllowedFullScreenDomain($origin);
        }
        $response->setFeaturePolicy($featurePolicy);

        return $response;
    }

    private function originOf(string $url): ?string {
        if ($url === '') {
            return null;
        }
        $parts = parse_url($url);
        if (!isset($parts['scheme'], $parts['host'])) {
            return null;
        }
        $origin = $parts['scheme'] . '://' . $parts['host'];
        if (isset($parts['port'])) {
            $origin .= ':' . $parts['port'];
        }
        return $origin;
    }
}
