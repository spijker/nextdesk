<?php

declare(strict_types=1);

namespace OCA\Nextdesk\Controller;

use OCP\AppFramework\Controller;
use OCP\AppFramework\Http\ContentSecurityPolicy;
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
        $csp = new ContentSecurityPolicy();
        $origin = $this->originOf($url);
        if ($origin !== null) {
            $csp->addAllowedFrameDomain($origin);
        }
        $response->setContentSecurityPolicy($csp);
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
