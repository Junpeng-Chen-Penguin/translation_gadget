CREATE DATABASE IF NOT EXISTS `standard_lexicon`
  DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

USE `standard_lexicon`;

CREATE TABLE IF NOT EXISTS `lexicon` (
  `id`             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `source_text`    VARCHAR(500) NOT NULL COMMENT '中文词条',
  `translation_en` VARCHAR(500) NOT NULL DEFAULT '' COMMENT '英文翻译',
  `lexicon_type`   VARCHAR(50)  NOT NULL DEFAULT '引入词条' COMMENT '词条来源类型',
  `created_at`     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_source_text` (`source_text`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
