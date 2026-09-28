import $ from "jquery";

export function changeCSSColumnWidth() {
  const setHelperCss = (selector: string, styles: JQuery.PlainObject) => {
    $(selector).each(function () {
      const element = $(this);
      if (!element.hasClass("usc-helper-modified-style")) {
        element
          .attr("data-usc-helper-original-style", element.attr("style") ?? "")
          .addClass("usc-helper-modified-style");
      }
      element.css(styles);
    });
  };

  //Sets CSS of page to display everything correctly
  setHelperCss(".rm_", {
    width: "4%",
  });
  setHelperCss(".btnAddToMyCourseBin", {
    width: "12%",
    float: "right",
  });

  setHelperCss(".session", {
    width: "4%",
  });

  $("#usc-schedule-helper-styles").remove();
  $(`<style id="usc-schedule-helper-styles" type='text/css'>
@media (min-width: 992px) {
    .text-md-center {
        text-align: center;
    }
}

.spots_remaining {
    padding-right: 2rem;
    border-radius: 24px;
}

.overlaps {
    background-color: var(--ush-overlap-bg, rgba(255, 134, 47, 0.37));
    border-radius: 24px;
}

.closed {
    background-color: var(--ush-closed-bg, rgba(255,118,96,0.29));
    border-radius: 24px;
}

.closedAndOverlaps {
    background: var(--ush-closed-overlap-bg, linear-gradient(to right, rgba(240, 65, 36, 0.45), rgba(234,121,39,0.37))) !important;
}

.crsTitlCustom {
color: var(--ush-text, black);
font-size: 1rem;
}

     </style>`).appendTo("head");
}
