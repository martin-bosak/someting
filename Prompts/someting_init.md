# Idea - Hosting
I want to create a platform that would sit on single VPS and provide hosting capabilities 
I have several really small web pages (personal ones)
I would like to have there a management app to configure sites, domains and see logs, redeploy from various sources
I can configure dns for my domains - would like that different domains 2nd and 3rd level ones would point to those hostings and this vps would handle that

# Technical part 
I have a small VPS on Hetzner - cx23 with 2vcpu, 4GB Ram, 40 GB SSD
Some of the pages to be hosted are PHP, some node/react, some python
They have usually mysql/pysql database - I would like to have probably just one pysql there
Now the pages are hosted on Azure web apps, GCP cloud run, Active24.cz and vedos hosting
Most of the sources are on separate github repositories
I will provide you a command to ssh into this VPS (later) for deployment
Probably dont need contenerization there (or would it be best/required), idea is to have those sites in different folders

# mailhosting
as additional/optional I would like to have there also app/possibility to have there email server or maybe a proxy?

# questions
Is it possible?
What are limiations?
Can you prepare a plan?
What else should I add, what is missing?