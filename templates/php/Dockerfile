FROM php:8.3-apache
RUN apt-get update \
  && apt-get install -y --no-install-recommends libpq-dev \
  && docker-php-ext-install pdo_pgsql pgsql \
  && rm -rf /var/lib/apt/lists/* \
  && sed -ri 's/Listen 80/Listen 8080/' /etc/apache2/ports.conf \
  && sed -ri 's/:80/:8080/g' /etc/apache2/sites-available/*.conf \
  && a2enmod rewrite headers
WORKDIR /var/www/html
COPY . .
EXPOSE 8080
