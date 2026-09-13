<?php

declare(strict_types=1);

namespace OCA\Nextdesk\Settings;

use OCP\AppFramework\Http\TemplateResponse;
use OCP\IConfig;
use OCP\IURLGenerator;
use OCP\Settings\ISettings;

class Admin implements ISettings {
    public function __construct(
        private IConfig $config,
        private IURLGenerator $urlGenerator,
    ) {
    }

    public function getForm(): TemplateResponse {
        return new TemplateResponse('nextdesk', 'admin', [
            'url' => $this->config->getAppValue('nextdesk', 'url', ''),
            'logoUrl' => $this->urlGenerator->imagePath('nextdesk', 'app.png'),
        ]);
    }

    public function getSection(): string {
        return 'nextdesk';
    }

    public function getPriority(): int {
        return 50;
    }
}
