<?php

declare(strict_types=1);

namespace OCA\Nextdesk\Settings;

use OCP\IL10N;
use OCP\IURLGenerator;
use OCP\Settings\IIconSection;

class AdminSection implements IIconSection {
    public function __construct(
        private IL10N $l,
        private IURLGenerator $urlGenerator,
    ) {
    }

    public function getIcon(): string {
        return $this->urlGenerator->imagePath('nextdesk', 'app.png');
    }

    public function getID(): string {
        return 'nextdesk';
    }

    public function getName(): string {
        return $this->l->t('Nextdesk');
    }

    public function getPriority(): int {
        return 75;
    }
}
